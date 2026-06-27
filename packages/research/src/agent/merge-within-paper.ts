import { z } from 'zod';
import { Candidate, Lens } from '../types';
import type { ResearchGenerateObject } from './research-generate';
import { SIM_FLOOR, SIM_CEIL, lexSim } from './dedup';

export interface MergeResult {
  candidates: Candidate[];
  tokens: number;
}

const MergeSchema = z.object({
  groups: z.array(z.array(z.number().int())),
});

/** Collapse the lens candidates from ONE paper into its distinct techniques, replacing the old O(n²)
 * pairwise loop (which could fire 100+ triage-LLM calls per paper) with a single clustering call
 * (slice 06). The shared lexical prefilter (slice 04) does the cheap work first: pairs at or above the
 * ceiling are obviously the same and merge with NO LLM; pairs below the floor are obviously distinct
 * and stay apart. Only candidates caught in the ambiguous band go to the model — ONE call that groups
 * same-technique candidates. Each resulting cluster yields one survivor keeping the first member's
 * verbatim sourceText, with the contributing lenses unioned and a distinct-lens agreement count (the
 * robustness signal the judge consumes). Fail-open (ADR-0021): a clustering error or schema-absent reply
 * keeps the lexical clusters as-is and never drops a candidate. */
export async function mergeWithinPaper(genObj: ResearchGenerateObject, candidates: Candidate[]): Promise<MergeResult> {
  const n = candidates.length;
  if (n <= 1) return { candidates: candidates.map(survivor), tokens: 0 };

  // Union-find over the paper's candidates. Obvious duplicates (≥ ceiling) union deterministically;
  // ambiguous-band pairs only flag their endpoints for the one LLM clustering call below.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  const ambiguous = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = lexSim(candidates[i], candidates[j]);
      if (s >= SIM_CEIL) union(i, j);
      else if (s >= SIM_FLOOR) { ambiguous[i] = true; ambiguous[j] = true; }
    }
  }

  let tokens = 0;
  const involved = candidates.map((_, i) => i).filter((i) => ambiguous[i]);
  if (involved.length > 1) {
    const prompt =
      `These coping/wellbeing techniques came from one paper. Group the ones that describe essentially ` +
      `the SAME technique. Return a JSON array of groups, each group an array of the 0-based indices ` +
      `that belong together (every index appears in exactly one group).\n` +
      involved.map((g, local) => `${local}: ${candidates[g].title} — ${candidates[g].technique}`).join('\n');
    try {
      const { object, tokens: t } = await genObj('merge', 'research-triage', { prompt, schema: MergeSchema });
      tokens = t;
      // When object is present apply the groups; when absent (schema/soft failure) keep the lexical
      // clusters as-is — the in-range filter still runs so a hallucinated index never corrupts union-find.
      if (object !== undefined) {
        for (const group of filterGroups(object.groups, involved.length)) {
          for (const local of group) if (local !== group[0]) union(involved[group[0]], involved[local]);
        }
      }
    } catch {
      // Fail-open: keep the lexical clusters as they stand; never drop a candidate on a clustering error.
    }
  }

  // Assemble one survivor per union-find component, in first-seen order so the survivor's verbatim
  // sourceText is the earliest member's.
  const byRoot = new Map<number, Candidate[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(candidates[i]);
  }
  return { candidates: [...byRoot.values()].map(mergeCluster), tokens };
}

/** A lone candidate as a survivor: its own lens, agreement 1. */
function survivor(c: Candidate): Candidate {
  const lenses = c.lens ? [c.lens] : [];
  return { ...c, lenses, lensAgreement: lenses.length };
}

/** Collapse a cluster into one survivor: first member's verbatim sourceText, unioned lenses, count. */
function mergeCluster(members: Candidate[]): Candidate {
  const lenses = new Set<Lens>();
  for (const m of members) for (const l of m.lenses ?? (m.lens ? [m.lens] : [])) lenses.add(l);
  return { ...members[0], lenses: [...lenses], lensAgreement: lenses.size };
}

/** Filter the model's decoded group array to in-range integer indices [0, n). A schema validates the
 * integer constraint; the range constraint is runtime: a hallucinated/out-of-range index would otherwise
 * resolve to `undefined` and silently corrupt the union-find (the catch never fires for this). */
function filterGroups(groups: number[][], n: number): number[][] {
  return groups
    .map((g) => g.filter((i) => Number.isInteger(i) && i >= 0 && i < n))
    .filter((g) => g.length > 0);
}
