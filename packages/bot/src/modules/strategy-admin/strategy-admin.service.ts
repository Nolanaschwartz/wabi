import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { StrategyTrustGate, StrategyDraft, EvaluationDecision } from './strategy-trust-gate';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { SchedulerService } from '../scheduler/scheduler.service';

const DEMOTE_QUEUE = 'strategy-demote';

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
  }

  async submitDraft(draft: StrategyDraft): Promise<StrategyDraft> {
    const result = await this.trustGate.evaluate(draft);

    const status = result.decision === 'publish' ? 'published' : 'pending-review';

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

    const persistedDraft = this.toDraft(persisted);
    if (status === 'published') {
      await this.publishToQdrant(persistedDraft);
    }
    return persistedDraft;
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

    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { status: 'published' },
    }).catch(() => null);

    if (!updated) return null;

    const draft = this.toDraft(updated);
    await this.publishToQdrant(draft);
    return draft;
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

  private async publishToQdrant(draft: StrategyDraft): Promise<void> {
    await this.retrieval.upsert(
      draft.id,
      `${draft.title}: ${draft.technique}`,
      draft.evidence,
    );
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
