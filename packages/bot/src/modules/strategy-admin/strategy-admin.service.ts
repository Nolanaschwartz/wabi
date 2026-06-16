import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { StrategyTrustGate, StrategyDraft, EvaluationDecision } from './strategy-trust-gate';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { SchedulerService } from '../scheduler/scheduler.service';

const DEMOTE_QUEUE = 'strategy-demote';
const RECONCILE_QUEUE = 'strategy-reconcile';
// Re-assert the index hourly — frequent enough to heal drift quickly, cheap for a small library.
const RECONCILE_CRON = '0 * * * *';

// Cosine similarity at/above this counts a candidate as already-present (ADR-0012 dedup).
// Resolved lazily per call — never cache env-derived config (CLAUDE.md).
function dedupThreshold(): number {
  return parseFloat(process.env.RESEARCH_DEDUP_THRESHOLD || '0.95');
}

@Injectable()
export class StrategyAdminService {
  constructor(
    private readonly trustGate: StrategyTrustGate,
    private readonly retrieval: StrategyRetrievalService,
    private readonly scheduler: SchedulerService,
  ) {}

  async init(): Promise<void> {
    // Register the demote worker on the shared Scheduler. When degraded, this no-ops and
    // enqueueDemote falls back to synchronous processing (below).
    await this.scheduler.work(DEMOTE_QUEUE, this.demoteJob.bind(this));
    // Periodic reconcile sweep keeps the Qdrant index in agreement with Postgres status.
    await this.scheduler.cron(RECONCILE_QUEUE, RECONCILE_CRON, async () => {
      await this.reconcile();
    });
  }

  async submitDraft(draft: StrategyDraft): Promise<StrategyDraft> {
    const result = await this.trustGate.evaluate(draft);
    const wantsPublish = result.decision === 'publish';

    // Index BEFORE declaring 'published', so a published Draft is always retrievable (ADR-0012). If
    // the index write fails, fall back to pending-review rather than persisting something invisible.
    const indexed = wantsPublish ? await this.publishToQdrant(draft) : false;
    const status = wantsPublish && indexed ? 'published' : 'pending-review';

    const persisted = await prisma.strategyDraft.create({
      data: {
        id: draft.id,
        title: draft.title,
        technique: draft.technique,
        source: draft.source,
        evidence: draft.evidence,
        sourceText: draft.sourceText ?? null,
        sourceUrl: draft.sourceUrl,
        trustLevel: draft.trustLevel,
        status,
      },
    });

    return this.toDraft(persisted);
  }

  /** True when the published library already contains a near-identical strategy. Queries the same
   * "title: technique" string the index is built from (publishToQdrant), so query and corpus match. */
  async isDuplicate(title: string, technique: string): Promise<boolean> {
    const [top] = await this.retrieval.search(`${title}: ${technique}`, 1);
    return !!top && typeof top.score === 'number' && top.score >= dedupThreshold();
  }

  /** Source-level idempotency: has this paper been processed on any prior run? (ADR-0033) */
  async hasSeen(sourceId: string): Promise<boolean> {
    const row = await prisma.processedSource.findUnique({ where: { sourceId } });
    return row !== null;
  }

  /** Record a terminal ingest outcome for a source. Upsert keeps firstSeenAt, refreshes lastStatus. */
  async markProcessed(
    sourceId: string,
    source: string,
    status: 'submitted' | 'deduped' | 'rejected',
  ): Promise<void> {
    await prisma.processedSource.upsert({
      where: { sourceId },
      create: { sourceId, source, lastStatus: status },
      update: { lastStatus: status },
    });
  }

  async getPendingDrafts(): Promise<StrategyDraft[]> {
    const drafts = await prisma.strategyDraft.findMany({
      where: { status: 'pending-review' },
      orderBy: { createdAt: 'desc' },
    });

    return drafts.map(this.toDraft);
  }

  async approveDraft(id: string): Promise<StrategyDraft | null> {
    // Only a pending-review draft may be published (ADR-0012 lifecycle). The guard lives here, in
    // the service — not just in the admin UI — so an already-published or quarantined draft can't be
    // flipped back through a stale/replayed request.
    const existing = await prisma.strategyDraft.findUnique({ where: { id } });
    if (!existing || existing.status !== 'pending-review') return null;

    // Index FIRST: a Draft only becomes 'published' once it is actually in the Qdrant index, so the
    // index can never silently lag Postgres (ADR-0012). A failed upsert leaves it pending-review for
    // a later retry (admin or the reconcile sweep), never published-but-unretrievable.
    const indexed = await this.publishToQdrant(this.toDraft(existing));
    if (!indexed) return null;

    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { status: 'published' },
    }).catch(() => null);

    return updated ? this.toDraft(updated) : null;
  }

  async rejectDraft(id: string): Promise<StrategyDraft | null> {
    // Same lifecycle guard: only a pending-review draft may be quarantined from review.
    const existing = await prisma.strategyDraft.findUnique({ where: { id } });
    if (!existing || existing.status !== 'pending-review') return null;

    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { status: 'quarantined' },
    }).catch(() => null);

    if (!updated) return null;

    await this.retrieval.delete(id);
    return this.toDraft(updated);
  }

  async setEvidenceLevel(id: string, evidence: string): Promise<StrategyDraft | null> {
    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { evidence },
    }).catch(() => null);

    return updated ? this.toDraft(updated) : null;
  }

  async recordNegativeFeedback(draftId: string): Promise<void> {
    const draft = await prisma.strategyDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== 'published') return;

    const newCount = draft.negativeCount + 1;

    if (this.trustGate.shouldQuarantine(newCount)) {
      await this.enqueueDemote(draftId);
    } else {
      await prisma.strategyDraft.update({
        where: { id: draftId },
        data: { negativeCount: newCount },
      });
    }
  }

  /**
   * Hand the demotion to the durable pg-boss queue so it is retried reliably
   * (ADR-0012). If the queue is unavailable (no DATABASE_URL / boss down), fall
   * back to processing it synchronously so feedback is never lost.
   */
  private async enqueueDemote(draftId: string): Promise<void> {
    if (this.scheduler.available) {
      try {
        await this.scheduler.send(DEMOTE_QUEUE, { draftId });
        return;
      } catch {
        // Fall through to synchronous demotion
      }
    }
    await this.applyDemote(draftId);
  }

  private async demoteJob(job: unknown[]): Promise<void> {
    const data = job[0] as { draftId: string };
    if (data?.draftId) {
      await this.applyDemote(data.draftId);
    }
  }

  /** Quarantine the Draft in Postgres and remove it from the Qdrant index. */
  async applyDemote(draftId: string): Promise<void> {
    await prisma.strategyDraft.update({
      where: { id: draftId },
      data: { status: 'quarantined', negativeCount: 0 },
    });
    await this.retrieval.delete(draftId);
  }

  private async publishToQdrant(draft: StrategyDraft): Promise<boolean> {
    return this.retrieval.upsert(
      draft.id,
      `${draft.title}: ${draft.technique}`,
      draft.evidence,
    );
  }

  /**
   * Re-assert the Qdrant index from Postgres (the source of truth for status): every 'published'
   * Draft must be present in the index, every 'quarantined' one absent. Idempotent, so it heals a
   * transient index failure on approve/reject AND a rebuilt or migrated collection (ADR-0012). Runs
   * on a Scheduler cron; safe to call directly.
   */
  async reconcile(): Promise<{ reindexed: number; removed: number }> {
    const [published, quarantined] = await Promise.all([
      prisma.strategyDraft.findMany({ where: { status: 'published' } }),
      prisma.strategyDraft.findMany({ where: { status: 'quarantined' } }),
    ]);

    let reindexed = 0;
    for (const row of published) {
      if (await this.publishToQdrant(this.toDraft(row))) reindexed++;
    }

    let removed = 0;
    for (const row of quarantined) {
      if (await this.retrieval.delete(row.id)) removed++;
    }

    return { reindexed, removed };
  }

  async getPublishedDrafts(): Promise<StrategyDraft[]> {
    const drafts = await prisma.strategyDraft.findMany({
      where: { status: 'published' },
      orderBy: { createdAt: 'desc' },
    });

    return drafts.map(this.toDraft);
  }

  private toDraft(row: any): StrategyDraft {
    return {
      id: row.id,
      title: row.title,
      technique: row.technique,
      source: row.source,
      evidence: row.evidence,
      sourceText: row.sourceText,
      sourceUrl: row.sourceUrl,
      trustLevel: row.trustLevel,
      status: row.status,
      negativeCount: row.negativeCount,
    };
  }
}
