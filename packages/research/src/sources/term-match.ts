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

/** Inverse document frequency of each term over `docs` (a window's title+abstract strings). Rare
 * terms score high; a term common across the whole window (e.g. "cognitive" in a clinical preprint
 * corpus) scores low and stops dominating the match. Smoothed (`+1` numerator/denominator, `+1`
 * floor) so a term in every — or no — doc is still well-defined and strictly positive. */
export function idf(terms: string[], docs: string[]): Map<string, number> {
  const lowered = docs.map((d) => d.toLowerCase());
  const weights = new Map<string, number>();
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`);
    const df = lowered.filter((d) => re.test(d)).length;
    weights.set(t, Math.log((lowered.length + 1) / (df + 1)) + 1);
  }
  return weights;
}

/** Sum of the idf weights of the query terms present in `text` as whole words — the rarity-weighted
 * counterpart to {@link scoreRecord}. Missing weights count as 0. */
export function weightedScore(text: string, terms: string[], weights: Map<string, number>): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (new RegExp(`\\b${escapeRegExp(t)}\\b`).test(hay)) score += weights.get(t) ?? 0;
  }
  return score;
}
