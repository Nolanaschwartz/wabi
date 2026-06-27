import { z } from 'zod';
import { Candidate, EvidenceTier } from '../types';
import type { ResearchGenerateObject } from './research-generate';
import { SCOPE_FRAGMENT } from './scope-policy';

export interface JudgeResult {
  candidates: Candidate[];
  tokens: number;
}

// Per-tier policy: preprints face a stricter faithfulness floor and a tighter cap (precision-leaning);
// peer-reviewed work is recall-leaning. Source quality sets the bar automatically.
function floorForTier(tier: EvidenceTier): number {
  return tier === 'preprint' ? 0.7 : 0.5;
}
function capForTier(tier: EvidenceTier): number {
  return tier === 'preprint' ? 2 : 5;
}

const JudgeSchema = z.object({
  verdicts: z.array(z.object({
    index: z.number().int(),
    faithful: z.boolean(),
    scopeOk: z.boolean(),
    score: z.number(),
    title: z.string(),
    technique: z.string(),
    rationale: z.string(),
  })),
});

type Verdict = z.infer<typeof JudgeSchema>['verdicts'][number];

/** Score, faithfulness-check, optionally sharpen, and cap a paper's candidates. The judge may rewrite
 * the human-facing title/technique but NEVER sourceText (faithfulness can't be laundered). Candidates
 * below the tier floor or marked unfaithful are dropped; survivors are capped top-N by score. Fail-open
 * (ADR-0021): a transport throw keeps every candidate at a neutral score rather than dropping silently;
 * a missing/malformed per-index verdict falls open individually without collapsing the rest of the batch. */
export async function judgeCandidates(genObj: ResearchGenerateObject, candidates: Candidate[], tier: EvidenceTier): Promise<JudgeResult> {
  if (candidates.length === 0) return { candidates: [], tokens: 0 };

  const prompt =
    `Judge each coping/wellbeing technique extracted from a research source.\n` +
    `${SCOPE_FRAGMENT}\n` +
    `For EACH item, score "faithful" (does the verbatim sourceText support the technique?), ` +
    `"scopeOk" (true ONLY if a person could do this unaided), and "score" (0..1 overall quality). ` +
    `You MAY sharpen title/technique wording but do NOT invent claims or change meaning. Keep a ` +
    `rewritten title short, plain, action-oriented.\n` +
    `Return JSON with a "verdicts" array — one object per input item:\n` +
    `{"verdicts":[{"index":0,"faithful":boolean,"scopeOk":boolean,"score":number,"title":string,"technique":string,"rationale":string}]}\n` +
    `Each verdict MUST include its 0-based \`index\` matching the input item. Return one verdict per item.\n` +
    `Output only the JSON object — no prose, no markdown.\n\n` +
    candidates.map((c, i) => `[${i}] Title: ${c.title}\nTechnique: ${c.technique}\nSourceText: ${c.sourceText}`).join('\n\n');

  let object: z.infer<typeof JudgeSchema> | undefined;
  let tokens = 0;
  try {
    // ponytail: batched output is N verdicts; extractMaxTokens() already carries reasoning headroom.
    // If a large paper's tail verdicts truncate (→ needless 0.5 fail-open), raise extractMaxTokens, not a per-call cap.
    const res = await genObj('judge', 'research', { prompt, schema: JudgeSchema });
    object = res.object;
    tokens = res.tokens;
  } catch {
    // Provider failure: nothing spent. Per-index fail-open — keep all at neutral, still capped per tier.
    return {
      candidates: candidates.slice(0, capForTier(tier)).map((c) => ({ ...c, confidence: 0.5, rationale: 'judge unavailable' })),
      tokens: 0,
    };
  }

  // When genObj returns object undefined (schema/soft failure), verdicts is empty → every index falls
  // open to the per-index neutral below. tokens are still counted from the successful call.
  const verdicts: Verdict[] = object?.verdicts ?? [];

  const kept: Candidate[] = [];
  candidates.forEach((c, i) => {
    const v = verdicts.find((x) => x.index === i);
    if (!v || typeof v.score !== 'number') {
      kept.push({ ...c, confidence: 0.5, rationale: 'judge unavailable' }); // per-index fail-open
      return;
    }
    if (!v.faithful || v.scopeOk === false || v.score < floorForTier(tier)) return; // dropped
    // sourceText is NEVER rewritten — only title/technique may be sharpened by the judge (ADR-0021).
    // An empty-string title/technique from the model falls back to the candidate's original (trim() guards '  ').
    const title = v.title?.trim() ? v.title : c.title;
    const technique = v.technique?.trim() ? v.technique : c.technique;
    kept.push({ ...c, title, technique, confidence: v.score, rationale: v.rationale ?? '' });
  });

  kept.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { candidates: kept.slice(0, capForTier(tier)), tokens };
}
