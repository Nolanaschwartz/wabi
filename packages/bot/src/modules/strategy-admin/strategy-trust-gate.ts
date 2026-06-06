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

const QUARANTINE_THRESHOLD = 3;

export interface StrategyDraft {
  id: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  sourceText?: string;
  sourceUrl: string;
  trustLevel: 'allowlisted' | 'community' | 'session-mined';
  status: 'draft' | 'pending-review' | 'published' | 'quarantined';
  negativeCount?: number;
}

export type EvaluationDecision = 'publish' | 'queue' | 'reject';

export class StrategyTrustGate {
  async evaluate(draft: StrategyDraft): Promise<{
    decision: EvaluationDecision;
    reason: string;
  }> {
    // Session-mined drafts always go to queue regardless of source
    if (draft.trustLevel === 'session-mined') {
      return {
        decision: 'queue',
        reason: 'Session-mined draft — requires human review',
      };
    }

    const isAllowlisted = this.isSourceAllowlisted(draft.sourceUrl);

    // Non-allowlisted sources go to queue
    if (!isAllowlisted) {
      return {
        decision: 'queue',
        reason: 'Source not allowlisted — queued for human review',
      };
    }

    // Allowlisted sources: run safety + faithfulness for auto-publish
    const safetyCheck = await this.safetyFilter(draft);
    if (!safetyCheck) {
      return {
        decision: 'reject',
        reason: 'Failed safety filter',
      };
    }

    const faithfulness = await this.faithfulnessCheck(draft);
    if (!faithfulness) {
      return {
        decision: 'reject',
        reason: 'Technique not faithful to cited source',
      };
    }

    return {
      decision: 'publish',
      reason: 'Allowlisted + safe + faithful — auto-published',
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

      const sourceTextSection = draft.sourceText
        ? `\nSource Text: ${draft.sourceText}`
        : '';

      const { text } = await generateText({
        model: openai(config.model),
        prompt: `Does this technique actually appear in the cited source? Return only "faithful" or "unfaithful":
Technique: ${draft.technique}
Source: ${draft.source}
Evidence: ${draft.evidence}${sourceTextSection}`,
        maxOutputTokens: 10,
      });

      return text.trim().toLowerCase() === 'faithful';
    } catch {
      return false;
    }
  }

  shouldQuarantine(negativeCount: number): boolean {
    return negativeCount >= QUARANTINE_THRESHOLD;
  }

  static quarantine(draft: StrategyDraft): StrategyDraft {
    return {
      ...draft,
      status: 'quarantined',
    };
  }
}
