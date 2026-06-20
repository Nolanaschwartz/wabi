import { generate } from '@wabi/shared/generate';
import { extractMaxTokens } from '../config';
import { Candidate, EvidenceTier } from '../types';
import { StepTrace } from './relevance-gate';
import { stripFences } from './extract';
import { SCOPE_FRAGMENT } from './scope-policy';

export interface JudgeResult {
  candidates: Candidate[];
  tokens: number;
  traces: StepTrace[];
}

// Per-tier policy: preprints face a stricter faithfulness floor and a tighter cap (precision-leaning);
// peer-reviewed work is recall-leaning. Source quality sets the bar automatically.
function floorForTier(tier: EvidenceTier): number {
  return tier === 'preprint' ? 0.7 : 0.5;
}
function capForTier(tier: EvidenceTier): number {
  return tier === 'preprint' ? 2 : 5;
}

/** Score, faithfulness-check, optionally sharpen, and cap a paper's candidates. The judge may rewrite
 * the human-facing title/technique but NEVER sourceText (faithfulness can't be laundered). Candidates
 * below the tier floor or marked unfaithful are dropped; survivors are capped top-N by score. Fail-open
 * (ADR-0021): a judge error/parse failure keeps the candidate at a neutral score rather than dropping
 * it silently. */
export async function judgeCandidates(candidates: Candidate[], tier: EvidenceTier): Promise<JudgeResult> {
  const judged = await Promise.all(candidates.map((c) => judgeOne(c, tier)));

  let tokens = 0;
  const traces: StepTrace[] = [];
  const kept: Candidate[] = [];
  for (const j of judged) {
    tokens += j.tokens;
    if (j.trace) traces.push(j.trace);
    if (j.candidate) kept.push(j.candidate);
  }

  kept.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { candidates: kept.slice(0, capForTier(tier)), tokens, traces };
}

async function judgeOne(
  c: Candidate,
  tier: EvidenceTier,
): Promise<{ candidate: Candidate | null; tokens: number; trace?: StepTrace }> {
  const prompt =
    `Judge this coping/wellbeing technique extracted from a research source.\n` +
    `${SCOPE_FRAGMENT}\n` +
    `Score "faithful" (does the verbatim sourceText actually support the technique?), "scopeOk" ` +
    `(true ONLY if a person could do this unaided — false if it requires a supplement, drug, dosed ` +
    `nutrient, a specific food/diet, a clinician, or a device/procedure), and "score" ` +
    `(0..1 overall quality: grounded, actionable, audience-neutral, non-trivial).\n` +
    `You MAY sharpen the title/technique wording, but do NOT invent claims and do NOT change meaning.\n` +
    `If you rewrite the title, keep it short, plain, and action-oriented (what the person does) — not an academic label.\n` +
    `Return JSON: {"faithful": boolean, "scopeOk": boolean, "score": number, "title": string, "technique": string, "rationale": string}\n\n` +
    `Title: ${c.title}\nTechnique: ${c.technique}\nSourceText: ${c.sourceText}`;

  let out;
  try {
    out = await generate('research', { prompt, maxOutputTokens: extractMaxTokens() });
  } catch {
    // Provider failure: nothing was spent. Fail-open — keep at a neutral score, never silently drop.
    return { candidate: { ...c, confidence: 0.5, rationale: 'judge unavailable' }, tokens: 0 };
  }

  // generate() succeeded, so the spend is real and must be counted even if the body won't parse —
  // dropping it to 0 under-counts the run budget and defeats the tokenBudget/budget-pressure stops.
  const tokens = out.usage?.totalTokens ?? 0;
  const trace: StepTrace = { input: prompt, output: out.text, model: out.model, latencyMs: out.latencyMs, usage: out.usage };

  let v: { faithful?: boolean; scopeOk?: boolean; score?: number; title?: string; technique?: string; rationale?: string };
  try {
    v = JSON.parse(stripFences(out.text.trim()));
  } catch {
    // Fail-open on an unparseable reply, but still report the spend above.
    return { candidate: { ...c, confidence: 0.5, rationale: 'judge unavailable' }, tokens, trace };
  }

  // scopeOk is a separate verdict, not folded into the quality score, so the trace records WHY a
  // faithful-but-out-of-scope candidate (e.g. a supplement) was dropped (slice 03).
  if (!v.faithful || v.scopeOk === false || typeof v.score !== 'number' || v.score < floorForTier(tier)) {
    return { candidate: null, tokens, trace };
  }
  return {
    candidate: {
      ...c,
      title: v.title ?? c.title,
      technique: v.technique ?? c.technique,
      // sourceText deliberately untouched — faithfulness grounding is immutable.
      confidence: v.score,
      rationale: v.rationale ?? '',
    },
    tokens,
    trace,
  };
}
