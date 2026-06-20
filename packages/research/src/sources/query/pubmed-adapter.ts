import { Concepts } from './concepts';

/** Quote multi-word phrases so they search as a unit; leave single words bare. */
function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Render concepts into an E-utilities `term`. Only the `core` mechanism phrases constrain the search
 * (quoted, OR-ed); the domain `context` is DROPPED here. Two reasons: OR-ing context at the same level
 * as core made any context-only word ("stress", "break", "activation") a match — dragging in unrelated
 * biomedical papers (dog enteropathy, ARDS) that the gate then had to reject; and AND-ing it would be
 * the implicit-AND collapse that hid the mechanism literature. Relevance sort handles the soft boost.
 * Constrained to human studies via `humans[MeSH Terms]` (drops animal work; the old `OR english[Language]`
 * was always-true and so constrained nothing). Returns '' for empty concepts → caller falls back to the
 * raw topic. (`context` still drives the EPMC/OSF adapters, where it's scoped to title/abstract.)
 */
export function pubmedQuery(c: Concepts): string {
  if (c.core.length === 0) return '';
  const core = `(${c.core.map(quote).join(' OR ')})`;
  return `${core} AND humans[MeSH Terms]`;
}
