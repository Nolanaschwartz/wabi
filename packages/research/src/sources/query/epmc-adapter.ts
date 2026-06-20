import { Concepts } from './concepts';

/** Quote multi-word phrases; leave single words bare. */
function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Render concepts into a Europe PMC query body — core phrases OR-ed over title+abstract, with the
 * domain `context` OR-ed in as a non-constraining clause (never required). The caller appends the
 * source facet (e.g. `AND (SRC:PPR)`). Returns '' for empty concepts so the caller can fall back.
 *
 * Europe PMC field syntax: `TITLE:"x"` / `ABSTRACT:"x"`; here we search both via a grouped OR so a
 * match in either field counts.
 */
export function epmcQuery(c: Concepts): string {
  if (c.core.length === 0) return '';
  const phrases = [...c.core, ...c.context].map(quote);
  const titleOr = phrases.map((p) => `TITLE:${p}`).join(' OR ');
  const abstractOr = phrases.map((p) => `ABSTRACT:${p}`).join(' OR ');
  return `(${titleOr} OR ${abstractOr})`;
}
