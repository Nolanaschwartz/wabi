/**
 * Recency-aware memory ranking — a pure, dependency-free re-ranker for derived-memory candidates.
 *
 * The coach recalls facts from mem0 by semantic similarity, but for a wellbeing companion *recency*
 * matters: what someone has surfaced lately should weigh more than a one-off mention from months ago.
 * This module blends the two so retrieval favours recently-salient facts WITHOUT letting recency
 * override topical relevance.
 *
 * Design (see PRD recency-aware-memory-retrieval):
 *  - Additive boost, relevance-dominant: score = RELEVANCE_WEIGHT·similarity + RECENCY_WEIGHT·recency.
 *    Because recency is *added* (not multiplied), an old fact never decays to zero relevance — it only
 *    forgoes its recency bonus. The recency term is bounded by RECENCY_WEIGHT, so a similarity gap
 *    wider than RECENCY_WEIGHT can never be overturned by recency: recency is a tie-breaker/booster,
 *    not an override.
 *  - Recency is an exponential half-life decay over the fact's age (from `updatedAt`, which mem0 bumps
 *    when a fact is reinforced/merged — a better "last came up" signal than first-seen time).
 *  - A candidate with no `updatedAt` contributes no recency term, so it ranks on similarity alone and
 *    is never buried by a less-relevant but timestamped fact.
 *
 * Pure: `now` is injected (no clock access) so ordering is deterministic and exhaustively testable.
 */

export interface RankableMemory {
  /** The remembered fact text. */
  content: string;
  /** mem0 similarity score for the query (higher = more topically relevant). */
  similarity: number;
  /** When mem0 last updated this fact, in epoch milliseconds. Absent for hits with no timestamp. */
  updatedAt?: number;
}

/** Relevance leads. Kept at 1 so similarity is the primary axis. */
export const RELEVANCE_WEIGHT = 1;

/**
 * The most recency can lift a score. A similarity gap wider than this is never overturned by recency —
 * that bound is the "relevance-dominant" guarantee.
 */
export const RECENCY_WEIGHT = 0.25;

/** Age at which a fact's recency weight halves. ~2 weeks: tuned for week-to-week state, not identity. */
export const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Recency weight in [0, 1]: 1 for a just-now fact, halving every RECENCY_HALF_LIFE_MS. */
function recencyWeight(updatedAt: number | undefined, now: number): number {
  if (updatedAt === undefined) return 0;
  const ageMs = now - updatedAt;
  if (ageMs <= 0) return 1; // future timestamp (clock skew) → treat as freshest
  return Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
}

function blendedScore(memory: RankableMemory, now: number): number {
  return (
    RELEVANCE_WEIGHT * memory.similarity +
    RECENCY_WEIGHT * recencyWeight(memory.updatedAt, now)
  );
}

/**
 * Re-order `candidates` by the relevance-dominant recency blend, highest score first. Stable for exact
 * ties (preserves input order). Extra fields on each candidate are preserved.
 */
export function rankByRecency<T extends RankableMemory>(
  candidates: T[],
  now: number,
): T[] {
  return candidates
    .map((memory, index) => ({ memory, index, score: blendedScore(memory, now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.memory);
}
