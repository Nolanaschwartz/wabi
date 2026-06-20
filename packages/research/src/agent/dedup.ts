import { Candidate } from '../types';
import type { ResearchGenerate } from './research-generate';

const HIGH = 0.6;
// Below LOW: auto-distinct, no LLM. Above HIGH: auto-duplicate, no LLM. The band in between goes to
// the triage LLM. The floor is raised off the old 0.05 (which sent nearly every pair to the model)
// because normalization below now lifts genuine paraphrases — "box breathing" vs "square breathing
// drill" — out of near-zero overlap and into the band, instead of leaving them to be auto-rejected.
const LOW = 0.18;

// ponytail: curated stem/synonym/stopword folding, narrow on purpose. Real semantic dedup lives on
// the bot's embeddings; here we only need raw paraphrases to clear the floor. Upgrade path = embeddings.
// KNOWN TRADE: at floor 0.18, a genuine paraphrase whose normalized similarity stays below the floor
// AND isn't folded by the synonym map (which today only knows square↔box) auto-resolves as distinct
// with no LLM — both drafts then reach the human review queue (ADR-0012) as separate items. That is a
// recall cost paid deliberately to cut the merge LLM-call volume; it loses no data (a human dedups),
// and the upgrade that removes it is bot-style embeddings, not a bigger synonym list.
const SYNONYMS: Record<string, string> = { square: 'box' };
const STOPWORDS = new Set(['drill', 'down', 'daily', 'nightly', 'routine', 'practice', 'technique', 'exercise', 'method', 'step']);
function stem(w: string): string {
  return w.replace(/(ing|ed|s)$/, '');
}
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/\W+/)) {
    if (raw.length <= 2) continue;
    const w = SYNONYMS[stem(raw)] ?? stem(raw);
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}
function jaccard(a: string, b: string): number {
  const sa = tokens(a), sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
const sig = (c: Candidate) => `${c.title} ${c.technique}`;

/** Bounds of the ambiguous band, exported so the within-paper merge pre-pass (slice 06) shares the
 * exact same lexical floor/ceiling as cross-paper dedup: below the floor is obviously distinct, at or
 * above the ceiling is obviously the same — only the band in between needs the LLM. */
export const SIM_FLOOR = LOW;
export const SIM_CEIL = HIGH;

/** Normalized lexical similarity of two candidates' signatures (the same metric dedup prefilters on).
 * Below {@link SIM_FLOOR} the pair is obviously distinct and never needs an LLM. */
export function lexSim(a: Candidate, b: Candidate): number {
  return jaccard(sig(a), sig(b));
}

export interface DedupResult { duplicate: boolean; tokens: number }

/** In-run technique dedup with no embeddings (those live on the bot). Lexical prefilter decides the
 * clear cases; the triage LLM only adjudicates the ambiguous middle. */
export async function isDuplicateInRun(gen: ResearchGenerate, candidate: Candidate, kept: Candidate[]): Promise<DedupResult> {
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
    // The `gen` seam owns the mechanism (role→cap binding, lazy provider resolution, the call, span
    // emission); dedup keeps its role and its fail policy. No retry-on-empty — an empty/starved reply
    // maps to not-a-duplicate below, same as a transport error, so a second attempt buys nothing here.
    const prompt =
      `Are these two coaching techniques essentially the same? Answer only "same" or "different".\n` +
      `A: ${sig(candidate)}\nB: ${sig(best)}`;
    const { text, usage } = await gen('dedup', 'research-triage', { prompt });
    // Empty/uncertain output (e.g. a reasoning model starved by the cap) reads as NOT duplicate,
    // the safe direction — keep the candidate rather than silently drop it on an unparseable answer.
    return {
      duplicate: text.trim().toLowerCase().startsWith('same'),
      tokens: usage?.totalTokens ?? 0,
    };
  } catch {
    return { duplicate: false, tokens: 0 };
  }
}
