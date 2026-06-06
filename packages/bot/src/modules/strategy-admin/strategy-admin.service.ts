import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { StrategyTrustGate, StrategyDraft, EvaluationDecision } from './strategy-trust-gate';

@Injectable()
export class StrategyAdminService {
  constructor(
    private readonly trustGate: StrategyTrustGate,
  ) {}

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

    return this.toDraft(persisted);
  }

  async getPendingDrafts(): Promise<StrategyDraft[]> {
    const drafts = await prisma.strategyDraft.findMany({
      where: { status: 'pending-review' },
      orderBy: { createdAt: 'desc' },
    });

    return drafts.map(this.toDraft);
  }

  async approveDraft(id: string): Promise<StrategyDraft | null> {
    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { status: 'published' },
    }).catch(() => null);

    return updated ? this.toDraft(updated) : null;
  }

  async rejectDraft(id: string): Promise<StrategyDraft | null> {
    const updated = await prisma.strategyDraft.update({
      where: { id },
      data: { status: 'quarantined' },
    }).catch(() => null);

    return updated ? this.toDraft(updated) : null;
  }

  async recordNegativeFeedback(draftId: string): Promise<void> {
    const draft = await prisma.strategyDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== 'published') return;

    const newCount = draft.negativeCount + 1;

    if (this.trustGate.shouldQuarantine(newCount)) {
      await prisma.strategyDraft.update({
        where: { id: draftId },
        data: { status: 'quarantined', negativeCount: 0 },
      });
    } else {
      await prisma.strategyDraft.update({
        where: { id: draftId },
        data: { negativeCount: newCount },
      });
    }
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
