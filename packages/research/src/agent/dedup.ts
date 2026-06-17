import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { triageMaxTokens } from '../config';
import { Candidate } from '../types';

const HIGH = 0.6;
// Anything with non-trivial lexical overlap is ambiguous and goes to the LLM; only a clean
// near-zero overlap is auto-distinct. (A 0.2 floor wrongly auto-rejected genuine paraphrases
// like "box breathing" vs "square breathing drill", whose Jaccard is ~0.08.)
const LOW = 0.05;

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}
function jaccard(a: string, b: string): number {
  const sa = tokens(a), sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
const sig = (c: Candidate) => `${c.title} ${c.technique}`;

export interface DedupResult { duplicate: boolean; tokens: number }

/** In-run technique dedup with no embeddings (those live on the bot). Lexical prefilter decides the
 * clear cases; the triage LLM only adjudicates the ambiguous middle. */
export async function isDuplicateInRun(candidate: Candidate, kept: Candidate[]): Promise<DedupResult> {
  if (kept.length === 0) return { duplicate: false, tokens: 0 };

  let best = kept[0];
  let bestSim = 0;
  for (const k of kept) {
    const s = jaccard(sig(candidate), sig(k));
    if (s > bestSim) { bestSim = s; best = k; }
  }

  if (bestSim >= HIGH) return { duplicate: true, tokens: 0 };
  if (bestSim <= LOW) return { duplicate: false, tokens: 0 };

  try {
    const cfg = getProvider('research-triage');
    const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
    const { text, usage } = await generateText({
      model: openai(cfg.model),
      prompt:
        `Are these two coaching techniques essentially the same? Answer only "same" or "different".\n` +
        `A: ${sig(candidate)}\nB: ${sig(best)}`,
      maxOutputTokens: triageMaxTokens(),
    });
    // Empty/uncertain output (e.g. a reasoning model starved by the cap) reads as NOT duplicate,
    // the safe direction — keep the candidate rather than silently drop it on an unparseable answer.
    return { duplicate: text.trim().toLowerCase().startsWith('same'), tokens: usage?.totalTokens ?? 0 };
  } catch {
    return { duplicate: false, tokens: 0 };
  }
}
