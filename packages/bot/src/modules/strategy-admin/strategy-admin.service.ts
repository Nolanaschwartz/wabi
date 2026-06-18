import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { prisma } from '@wabi/shared';
import { StrategyTrustGate, StrategyDraft, EvaluationDecision } from './strategy-trust-gate';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { JobRegistry } from '../scheduler/job-registry';
import { Job } from '../scheduler/jobs';

export interface IngestCandidate {
  id?: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  sourceText?: string;
  sourceUrl: string;
  sourceId: string;
  sourceKind: string;
}

export interface IngestResult {
  status: 'submitted' | 'deduped' | 'rejected';
  draftId?: string;
}

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
    private readonly jobs: JobRegistry,
  ) {}

  init(): void {
    // Declare the demote worker. When degraded it never binds and enqueueDemote falls back to
    // synchronous processing (below).
    this.jobs.declare({
      name: Job.StrategyDemote,
      kind: 'work',
      owner: 'strategy-admin',
      handler: this.demoteJob.bind(this),
    });
    // Periodic reconcile sweep keeps the Qdrant index in agreement with Postgres status.
    this.jobs.declare({
      name: Job.StrategyReconcile,
      kind: 'cron',
      cron: RECONCILE_CRON,
      owner: 'strategy-admin',
      handler: async () => {
        await this.reconcile();
      },
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

  /**
   * Evaluate ONE candidate without touching the ledger: library dedup → trust gate (which, for
   * research-agent, runs safety+faithfulness but can only queue or reject) → persist. The trust
   * level is forced to 'research-agent' so this path can never auto-publish. Callers
   * (ingestCandidate / ingestBatch) own the per-source ledger mark, since the ledger is keyed per
   * source and one paper may now yield several drafts (ADR-0033).
   */
  private async evaluateCandidate(c: IngestCandidate): Promise<IngestResult> {
    if (await this.isDuplicate(c.title, c.technique)) {
      return { status: 'deduped' };
    }

    const draft: StrategyDraft = {
      id: c.id ?? randomUUID(),
      title: c.title,
      technique: c.technique,
      source: c.source,
      evidence: c.evidence,
      sourceText: c.sourceText,
      sourceUrl: c.sourceUrl,
      trustLevel: 'research-agent',
      status: 'draft',
    };

    // Evaluate up front so a safety/faithfulness rejection never persists (a reviewer must not see
    // a failed draft). On non-reject, submitDraft re-evaluates and persists as pending-review.
    const decision = await this.trustGate.evaluate(draft);
    if (decision.decision === 'reject') {
      return { status: 'rejected' };
    }

    const persisted = await this.submitDraft(draft);
    return { status: 'submitted', draftId: persisted.id };
  }

  /** Ingest a single research candidate. Thin wrapper over the per-source batch path. */
  async ingestCandidate(c: IngestCandidate): Promise<IngestResult> {
    const { results } = await this.ingestBatch([c]);
    return results[0];
  }

  /**
   * Ingest all drafts mined from ONE paper (a single sourceId) — a paper may now yield several
   * distinct techniques. Source-level idempotency is checked once and the ledger is marked once
   * for the whole batch; each draft is dedup'd and gated independently so a duplicate sibling
   * never sinks the others (ADR-0033). The batch is assumed homogeneous in sourceId/sourceKind.
   */
  async ingestBatch(candidates: IngestCandidate[]): Promise<{ results: IngestResult[] }> {
    if (candidates.length === 0) return { results: [] };

    const { sourceId, sourceKind } = candidates[0];

    // Bot-side idempotency on the authoritative sourceId key. The worker's seen() check is an
    // optimization, not a guarantee; this hard gate prevents re-processing a paper from a prior
    // run. No re-mark — the ledger already holds the terminal status.
    if (await this.hasSeen(sourceId)) {
      return { results: candidates.map(() => ({ status: 'deduped' as const })) };
    }

    const results: IngestResult[] = [];
    for (const c of candidates) {
      results.push(await this.evaluateCandidate(c));
    }

    // One ledger mark for the whole source. Precedence submitted > deduped > rejected: the paper's
    // terminal status reflects the best outcome any of its drafts achieved.
    const status: 'submitted' | 'deduped' | 'rejected' = results.some((r) => r.status === 'submitted')
      ? 'submitted'
      : results.some((r) => r.status === 'deduped')
        ? 'deduped'
        : 'rejected';
    await this.markProcessed(sourceId, sourceKind, status);

    return { results };
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
        await this.scheduler.send(Job.StrategyDemote, { draftId });
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
