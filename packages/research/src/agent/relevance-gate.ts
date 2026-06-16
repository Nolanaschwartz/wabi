import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';

export interface GateResult { keep: boolean; tokens: number }

/** Cheap relevance triage on a paper's abstract, before any full-text fetch (spec §Agent behavior).
 * Fails OPEN: on error we keep the paper rather than silently drop a possibly-relevant one. */
export async function relevanceGate(abstract: string): Promise<GateResult> {
  try {
    const cfg = getProvider('research-triage');
    const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
    const { text, usage } = await generateText({
      model: openai(cfg.model),
      prompt:
        `Does this abstract describe a concrete behavioral or psychological coping/wellbeing ` +
        `technique that could inform a coaching strategy? Answer only "yes" or "no".\n\n` +
        `Abstract: ${abstract}`,
      maxOutputTokens: 5,
    });
    return { keep: text.trim().toLowerCase().startsWith('yes'), tokens: usage?.totalTokens ?? 0 };
  } catch {
    return { keep: true, tokens: 0 };
  }
}
