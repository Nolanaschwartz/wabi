import { Concepts } from './concepts';

/** Quote multi-word phrases so they search as a unit; leave single words bare. */
function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Render concepts into an E-utilities `term`. Core phrases are quoted and OR-ed; the domain `context`
 * (when present) is OR-ed in as a NON-constraining clause — never AND-ed, because requiring the domain
 * word ("gaming") is exactly the implicit-AND collapse that hid the mechanism literature. Restricted
 * to human + English. Returns '' for empty concepts so the caller can fall back to the raw topic.
 */
export function pubmedQuery(c: Concepts): string {
  if (c.core.length === 0) return '';
  const groups = [c.core, ...(c.context.length ? [c.context] : [])].map(
    (g) => `(${g.map(quote).join(' OR ')})`,
  );
  const terms = groups.length > 1 ? `(${groups.join(' OR ')})` : groups[0];
  return `${terms} AND (humans[MeSH Terms] OR english[Language])`;
}
