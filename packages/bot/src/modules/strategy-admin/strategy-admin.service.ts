import { Injectable } from '@nestjs/common';
import { StrategyTrustGate, StrategyDraft } from './strategy-trust-gate';

@Injectable()
export class StrategyAdminService {
  private drafts: StrategyDraft[] = [];

  constructor(
    private readonly trustGate: StrategyTrustGate,
  ) {}

  async submitDraft(draft: StrategyDraft): Promise<StrategyDraft> {
    const result = await this.trustGate.evaluate(draft);

    const processed: StrategyDraft = {
      ...draft,
      status: result.approved ? 'published' : 'pending-review',
    };

    this.drafts.push(processed);
    return processed;
  }

  async getPendingDrafts(): Promise<StrategyDraft[]> {
    return this.drafts.filter((d) => d.status === 'pending-review');
  }

  async approveDraft(id: string): Promise<StrategyDraft | null> {
    const idx = this.drafts.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    this.drafts[idx] = {
      ...this.drafts[idx],
      status: 'published',
    };

    return this.drafts[idx];
  }

  async rejectDraft(id: string): Promise<StrategyDraft | null> {
    const idx = this.drafts.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    this.drafts[idx] = {
      ...this.drafts[idx],
      status: 'quarantined',
    };

    return this.drafts[idx];
  }

  async recordNegativeFeedback(draftId: string): Promise<void> {
    const draft = this.drafts.find((d) => d.id === draftId);
    if (!draft) return;

    if (draft.status === 'published') {
      const negativeCount = (draft as any).negativeCount ?? 0;
      if (negativeCount >= 3) {
        this.drafts = this.drafts.map((d) =>
          d.id === draftId
            ? { ...d, status: 'quarantined' as const, negativeCount: 0 }
            : d,
        );
      }
    }
  }

  async getPublishedDrafts(): Promise<StrategyDraft[]> {
    return this.drafts.filter((d) => d.status === 'published');
  }
}
