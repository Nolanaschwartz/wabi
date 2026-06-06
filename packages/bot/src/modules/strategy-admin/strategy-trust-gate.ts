import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';

const ALLOWLISTED_SOURCES = [
  'apa.org',
  'ncbi.nlm.nih.gov',
  'mayoclinic.org',
  'who.int',
  'counseling.org',
];

export interface StrategyDraft {
  id: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  sourceUrl: string;
  trustLevel: 'allowlisted' | 'community' | 'session-mined';
  status: 'draft' | 'pending-review' | 'published' | 'quarantined';
}

export class StrategyTrustGate {
  async evaluate(draft: StrategyDraft): Promise<{
    approved: boolean;
    reason: string;
  }> {
    const isAllowlisted = this.isSourceAllowlisted(draft.sourceUrl);

    if (!isAllowlisted) {
      return {
        approved: false,
        reason: 'Source not allowlisted — requires human review',
      };
    }

    const safetyCheck = await this.safetyFilter(draft);
    if (!safetyCheck) {
      return {
        approved: false,
        reason: 'Failed safety filter',
      };
    }

    const faithfulness = await this.faithfulnessCheck(draft);
    if (!faithfulness) {
      return {
        approved: false,
        reason: 'Technique not faithful to cited source',
      };
    }

    return {
      approved: true,
      reason: 'Passed all checks — auto-published',
    };
  }

  private isSourceAllowlisted(sourceUrl: string): boolean {
    return ALLOWLISTED_SOURCES.some((domain) => sourceUrl.includes(domain));
  }

  private async safetyFilter(draft: StrategyDraft): Promise<boolean> {
    try {
      const config = getProvider('classifier');
      const openai = createOpenAI({
        baseURL: config.baseUrl as string,
        apiKey: config.apiKey,
      });

      const { text } = await generateText({
        model: openai(config.model),
        prompt: `Evaluate if this strategy is safe. Return only "safe" or "unsafe":
Title: ${draft.title}
Technique: ${draft.technique}
Source: ${draft.source}`,
        maxOutputTokens: 10,
      });

      return text.trim().toLowerCase() === 'safe';
    } catch {
      return false;
    }
  }

  private async faithfulnessCheck(draft: StrategyDraft): Promise<boolean> {
    try {
      const config = getProvider('classifier');
      const openai = createOpenAI({
        baseURL: config.baseUrl as string,
        apiKey: config.apiKey,
      });

      const { text } = await generateText({
        model: openai(config.model),
        prompt: `Does this technique actually appear in the cited source? Return only "faithful" or "unfaithful":
Technique: ${draft.technique}
Source: ${draft.source}
Evidence: ${draft.evidence}`,
        maxOutputTokens: 10,
      });

      return text.trim().toLowerCase() === 'faithful';
    } catch {
      return false;
    }
  }

  static quarantine(draft: StrategyDraft): StrategyDraft {
    return {
      ...draft,
      status: 'quarantined',
    };
  }
}
