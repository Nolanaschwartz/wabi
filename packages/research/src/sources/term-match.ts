/**
 * Shared query content-term scoring for preprint sources (medRxiv, PsyArXiv). Extracted verbatim
 * from `MedrxivTool` so every source ranks papers by identical rules. Pure functions, no I/O.
 */

// Dropped from queries before matching: too generic to carry topical meaning. Short tokens (<3 chars)
// are dropped too. What remains are the content terms a record is scored against.
export const STOPWORDS = new Set([
  'and', 'for', 'the', 'with', 'from', 'into', 'that', 'this', 'your', 'their', 'after', 'during',
  'using', 'based', 'study', 'among', 'between', 'effect', 'effects',
]);

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Content terms of a query: lowercase tokens of length ≥3 that aren't stopwords. Falls back to
 * the raw tokens if everything was filtered out (e.g. a query of only short/stop words). */
export function contentTerms(query: string): string[] {
  const raw = query.toLowerCase().split(/\W+/).filter(Boolean);
  const terms = raw.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return terms.length ? terms : raw;
}

/** How many of a query's content terms a record must contain to be kept.
 * ≤2 terms: require all (a 1–2 word query is already specific). More: require a fraction, min 2. */
export function minMatch(termCount: number, minTermFraction: number): number {
  return termCount <= 2 ? termCount : Math.max(2, Math.ceil(termCount * minTermFraction));
}

/** Number of query content terms present in `text` as whole words (not substrings):
 * "term" must not count inside "determine". Case-insensitive on the text; terms are assumed
 * already lowercase (as produced by `contentTerms`). */
export function scoreRecord(text: string, terms: string[]): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (new RegExp(`\\b${escapeRegExp(t)}\\b`).test(hay)) score++;
  }
  return score;
}
