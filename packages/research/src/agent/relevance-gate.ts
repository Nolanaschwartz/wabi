import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { triageMaxTokens } from '../config';

export interface GateResult { keep: boolean; tokens: number }

/** Cheap relevance triage on a paper's abstract, before any full-text fetch (spec §Agent behavior).
 * Fails OPEN: keep the paper unless the model clearly says "no". Empty/uncertain output keeps it too
 * — a reasoning model whose answer is starved by the token cap returns "" and we must NOT read that
 * as a rejection (doing so silently dropped every paper against the local model). */
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
      maxOutputTokens: triageMaxTokens(),
    });
    const t = (text ?? '').trim().toLowerCase();
    return { keep: !t.startsWith('no'), tokens: usage?.totalTokens ?? 0 };
  } catch {
    return { keep: true, tokens: 0 };
  }
}
