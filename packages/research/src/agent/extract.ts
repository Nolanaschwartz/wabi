import { generate } from '@wabi/shared/generate';
import { extractMaxTokens } from '../config';
import { Paper, Candidate } from '../types';
import { StepTrace } from './relevance-gate';

const HIGH_TIER = ['Meta-Analysis', 'Systematic Review', 'Randomized Controlled Trial'];

/** Strip a ```json … ``` (or bare ``` … ```) fence some models wrap JSON in, so JSON.parse sees the
 * object. Returns the inner content trimmed, or the input unchanged when there is no fence. */
function stripFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m ? m[1] : s).trim();
}

/** Evidence tag is set from the source's nature, never the model's self-claim (ADR-0012). */
export function evidenceTag(paper: Paper): string {
  if (paper.isPreprint) return 'preprint: not peer-reviewed';
  const tier = paper.pubTypes.find((t) => HIGH_TIER.includes(t));
  return tier ? `peer-reviewed: ${tier}` : 'peer-reviewed: observational';
}

export interface ExtractResult { candidate: Candidate | null; tokens: number; trace?: StepTrace }

/** One source body → one generalized, grounded candidate or null. The technique must be
 * audience-neutral (no game-specific framing — that's coaching-time work) and the sourceText must be
 * a VERBATIM quote, validated here as an actual substring so faithfulnessCheck can't be gamed. */
export async function extract(paper: Paper, body: string): Promise<ExtractResult> {
  let text = '';
  let tokens = 0;
  let trace: StepTrace | undefined;
  try {
    // generate owns the mechanism (lazy provider resolution, the client, the call); extract keeps its
    // role, its cap, and its fail policy. No retry-on-empty here — a starved/empty result just maps to
    // null below, same as before. The verbatim-substring + JSON checks stay this module's job.
    const out = await generate('research', {
      prompt:
        `From the source below, extract ONE transferable, actionable coping/wellbeing technique, ` +
        `or return exactly "null" if there is no clean, safe, self-contained technique.\n` +
        `Rules:\n` +
        `- Write the technique in audience-neutral language. Do NOT mention games, gamers, ranked, ` +
        `tilt, or any specific population — describe the general mechanism only.\n` +
        `- "sourceText" MUST be a verbatim quote copied exactly from the source (a real substring).\n` +
        `Return JSON: {"title": string, "technique": string, "sourceText": string} or the literal null.\n\n` +
        `Source:\n${body}`,
      maxOutputTokens: extractMaxTokens(),
    });
    text = stripFences(out.text.trim());
    tokens = out.usage?.totalTokens ?? 0;
    // The raw model output is the span output; the body it read is the span input (on-infra retention).
    trace = { input: body, output: out.text, model: out.model, latencyMs: out.latencyMs, usage: out.usage };
  } catch {
    return { candidate: null, tokens: 0 };
  }

  if (text === '' || text.toLowerCase() === 'null') return { candidate: null, tokens, trace };

  let parsed: { title?: string; technique?: string; sourceText?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { candidate: null, tokens, trace };
  }

  const { title, technique, sourceText } = parsed;
  if (!title || !technique || !sourceText) return { candidate: null, tokens, trace };
  if (!body.includes(sourceText)) return { candidate: null, tokens, trace };

  return {
    trace,
    candidate: {
      title,
      technique,
      sourceText,
      evidence: evidenceTag(paper),
      sourceUrl: paper.url,
      source: paper.sourceKind === 'medrxiv' ? 'medRxiv (preprint)' : 'PubMed',
      sourceId: paper.sourceId,
      sourceKind: paper.sourceKind,
      trustLevel: 'research-agent',
    },
    tokens,
  };
}
