import { Candidate } from '../types';
import type { ResearchGenerate } from './research-generate';
import { embed } from '@wabi/shared/embed';

// ponytail: curated stem/synonym/stopword folding, narrow on purpose. Real semantic dedup now lives
// in isDuplicateInRun (embed cosine); these helpers survive as the fail-open lexical fallback AND
// because merge-within-paper.ts imports SIM_FLOOR/SIM_CEIL/lexSim for within-paper clustering.
// KNOWN TRADE: the lexical fallback (embed down) only fires the ceiling rule — ambiguous-band pairs
// resolve DISTINCT (more drafts to human review, no wrongful drops), no LLM.
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

/** Bounds of the ambiguous band, exported so the within-paper merge pre-pass shares the exact same
 * lexical floor/ceiling as the fallback: below the floor is obviously distinct, at or above the ceiling
 * is obviously the same. Used by merge-within-paper.ts. */
export const SIM_FLOOR = 0.18;
export const SIM_CEIL = 0.6;

/** Normalized lexical similarity of two candidates' signatures. Below {@link SIM_FLOOR} the pair is
 * obviously distinct. Used by merge-within-paper.ts. */
export function lexSim(a: Candidate, b: Candidate): number {
  return jaccard(sig(a), sig(b));
}

export interface DedupResult {
  duplicate: boolean;
  tokens: number;
  /** True when the embedder was down and this verdict came from the lexical-ceiling fallback, not
   * embeddings. The run logs this once so a silent embedding outage (missing EMBEDDING_*, ADR-0034)
   * is visible rather than a quiet recall drop (ambiguous-band paraphrases resolve DISTINCT). */
  degraded?: boolean;
}

// ─── Embedding cosine path ──────────────────────────────────────────────────

// Cosine at/above this counts an in-run duplicate. Reuses the bot's library-dedup knob so the two
// dedups share one scale (strategy-admin dedupThreshold()). High by design: in-run dedup is LOSSY
// (a duplicate is dropped, never reaching human review), so fail toward sending paraphrases to review.
function dupThreshold(): number {
  return parseFloat(process.env.RESEARCH_DEDUP_THRESHOLD || '0.95');
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** The exact string the bot's index/dedup query is built from, so our cosine scale matches the bot's. */
const embedSig = (c: Candidate) => `${c.title}: ${c.technique}`;

/** Lexical fallback (embedder down): the original ceiling-only rule — a clear paraphrase merges, the
 * ambiguous band resolves DISTINCT (no LLM), per spec (more drafts to human, no wrongful drops). */
function lexicalDuplicate(candidate: Candidate, kept: Candidate[]): boolean {
  return kept.some((k) => jaccard(sig(candidate), sig(k)) >= SIM_CEIL);
}

/** In-run technique dedup via embeddings (cross-run library dedup is the bot's, ADR-0012). `_gen` is
 * retained in the signature for call-site stability but unused — the embedding is the judgment. */
export async function isDuplicateInRun(_gen: ResearchGenerate, candidate: Candidate, kept: Candidate[]): Promise<DedupResult> {
  if (kept.length === 0) return { duplicate: false, tokens: 0 };

  const vec = await embed(embedSig(candidate));
  if (vec.length === 0) {
    // Fail-open: embedder down → lexical ceiling rule. No tokens spent (no LLM). `degraded` lets the
    // run surface the outage once (the embedding path is the intended judgment; this is the fallback).
    return { duplicate: lexicalDuplicate(candidate, kept), tokens: 0, degraded: true };
  }
  const keptVecs = await Promise.all(kept.map((k) => embed(embedSig(k))));
  const threshold = dupThreshold();
  const duplicate = keptVecs.some((kv) => cosine(vec, kv) >= threshold);
  return { duplicate, tokens: 0 };
}
