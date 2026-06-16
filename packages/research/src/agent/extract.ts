import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { Paper, Candidate } from '../types';

const HIGH_TIER = ['Meta-Analysis', 'Systematic Review', 'Randomized Controlled Trial'];

/** Evidence tag is set from the source's nature, never the model's self-claim (ADR-0012). */
export function evidenceTag(paper: Paper): string {
  if (paper.isPreprint) return 'preprint: not peer-reviewed';
  const tier = paper.pubTypes.find((t) => HIGH_TIER.includes(t));
  return tier ? `peer-reviewed: ${tier}` : 'peer-reviewed: observational';
}

export interface ExtractResult { candidate: Candidate | null; tokens: number }

/** One source body → one generalized, grounded candidate or null. The technique must be
 * audience-neutral (no game-specific framing — that's coaching-time work) and the sourceText must be
 * a VERBATIM quote, validated here as an actual substring so faithfulnessCheck can't be gamed. */
export async function extract(paper: Paper, body: string): Promise<ExtractResult> {
  const cfg = getProvider('research');
  const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });

  let text = '';
  let tokens = 0;
  try {
    const out = await generateText({
      model: openai(cfg.model),
      prompt:
        `From the source below, extract ONE transferable, actionable coping/wellbeing technique, ` +
        `or return exactly "null" if there is no clean, safe, self-contained technique.\n` +
        `Rules:\n` +
        `- Write the technique in audience-neutral language. Do NOT mention games, gamers, ranked, ` +
        `tilt, or any specific population — describe the general mechanism only.\n` +
        `- "sourceText" MUST be a verbatim quote copied exactly from the source (a real substring).\n` +
        `Return JSON: {"title": string, "technique": string, "sourceText": string} or the literal null.\n\n` +
        `Source:\n${body}`,
      maxOutputTokens: 400,
    });
    text = out.text.trim();
    tokens = out.usage?.totalTokens ?? 0;
  } catch {
    return { candidate: null, tokens: 0 };
  }

  if (text.toLowerCase() === 'null') return { candidate: null, tokens };

  let parsed: { title?: string; technique?: string; sourceText?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { candidate: null, tokens };
  }

  const { title, technique, sourceText } = parsed;
  if (!title || !technique || !sourceText) return { candidate: null, tokens };
  if (!body.includes(sourceText)) return { candidate: null, tokens };

  return {
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
