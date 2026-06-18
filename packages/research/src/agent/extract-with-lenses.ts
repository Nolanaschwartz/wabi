import { generate } from '@wabi/shared/generate';
import { extractMaxTokens } from '../config';
import { Paper, Candidate, Lens } from '../types';
import { StepTrace } from './relevance-gate';
import { evidenceTag, evidenceTier, stripFences } from './extract';

export interface LensExtractResult {
  candidates: Candidate[];
  tokens: number;
  traces: StepTrace[];
}

/** Fan one source body out across the given lenses in parallel. Each lens is prompted to surface
 * EVERY technique visible through its angle (0..K), so one paper can now yield several drafts. Like
 * {@link extract} the evidence/sourceText guards are non-negotiable: sourceText must be a verbatim
 * substring (hallucination guard) and the tier is set from the source, never the model. Fail-open
 * (ADR-0021): a lens that errors or returns nothing contributes [] and never aborts the others, so
 * the worst case degrades toward today's single-pass behaviour. */
export async function extractWithLenses(paper: Paper, body: string, lenses: Lens[]): Promise<LensExtractResult> {
  const perLens = await Promise.all(lenses.map((lens) => extractOneLens(paper, body, lens)));
  return {
    candidates: perLens.flatMap((r) => r.candidates),
    tokens: perLens.reduce((sum, r) => sum + r.tokens, 0),
    traces: perLens.flatMap((r) => (r.trace ? [r.trace] : [])),
  };
}

async function extractOneLens(
  paper: Paper,
  body: string,
  lens: Lens,
): Promise<{ candidates: Candidate[]; tokens: number; trace?: StepTrace }> {
  let out;
  try {
    out = await generate('research', {
      prompt:
        `Through the ${lens} lens, extract EVERY transferable, actionable coping/wellbeing technique ` +
        `the source describes that fits that angle. Return an empty array if none fit.\n` +
        `Rules:\n` +
        `- Write each technique in audience-neutral language. Do NOT mention games, gamers, ranked, ` +
        `tilt, or any specific population — describe the general mechanism only.\n` +
        `- Each "sourceText" MUST be a verbatim quote copied exactly from the source (a real substring).\n` +
        `Return JSON array: [{"title": string, "technique": string, "sourceText": string}] (or []).\n\n` +
        `Source:\n${body}`,
      maxOutputTokens: extractMaxTokens(),
    });
  } catch {
    return { candidates: [], tokens: 0 };
  }

  const tokens = out.usage?.totalTokens ?? 0;
  const trace: StepTrace = { input: body, output: out.text, model: out.model, latencyMs: out.latencyMs, usage: out.usage };
  const text = stripFences(out.text.trim());
  if (text === '' || text.toLowerCase() === 'null') return { candidates: [], tokens, trace };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { candidates: [], tokens, trace };
  }
  if (!Array.isArray(parsed)) return { candidates: [], tokens, trace };

  const candidates: Candidate[] = [];
  for (const item of parsed as { title?: string; technique?: string; sourceText?: string }[]) {
    const { title, technique, sourceText } = item ?? {};
    if (!title || !technique || !sourceText) continue;
    if (!body.includes(sourceText)) continue; // verbatim-substring hallucination guard
    candidates.push({
      title,
      technique,
      sourceText,
      evidence: evidenceTag(paper),
      evidenceTier: evidenceTier(paper),
      sourceUrl: paper.url,
      source: paper.sourceKind === 'medrxiv' ? 'medRxiv (preprint)' : 'PubMed',
      sourceId: paper.sourceId,
      sourceKind: paper.sourceKind,
      trustLevel: 'research-agent',
      lens,
    });
  }
  return { candidates, tokens, trace };
}
