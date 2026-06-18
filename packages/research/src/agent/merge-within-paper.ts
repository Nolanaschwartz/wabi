import { Candidate, Lens } from '../types';
import { StepTrace } from './relevance-gate';
import { isDuplicateInRun } from './dedup';

export interface MergeResult {
  candidates: Candidate[];
  tokens: number;
  traces: StepTrace[];
}

/** Collapse the lens candidates from ONE paper into its distinct techniques. Same-technique
 * candidates surfaced by different lenses merge into one, accumulating the contributing lenses and a
 * distinct-lens agreement count (a robustness signal for the judge, slice 05). Reuses the in-run
 * dedup similarity (Jaccard prefilter + triage-LLM tie-break on the ambiguous middle) so merge and
 * cross-paper dedup judge sameness the same way. The first survivor's verbatim sourceText is kept. */
export async function mergeWithinPaper(candidates: Candidate[]): Promise<MergeResult> {
  const merged: Candidate[] = [];
  let tokens = 0;
  const traces: StepTrace[] = [];

  for (const c of candidates) {
    let target: Candidate | undefined;
    for (const m of merged) {
      const dd = await isDuplicateInRun(c, [m]);
      tokens += dd.tokens;
      if (dd.trace) traces.push(dd.trace);
      if (dd.duplicate) { target = m; break; }
    }

    if (target) {
      const lenses = new Set<Lens>(target.lenses ?? []);
      if (c.lens) lenses.add(c.lens);
      target.lenses = [...lenses];
      target.lensAgreement = target.lenses.length;
    } else {
      const lenses = c.lens ? [c.lens] : [];
      merged.push({ ...c, lenses, lensAgreement: lenses.length });
    }
  }

  return { candidates: merged, tokens, traces };
}
