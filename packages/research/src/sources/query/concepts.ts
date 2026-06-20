import { generate } from '@wabi/shared/generate';
import { triageMaxTokens } from '../../config';
import { stripFences } from '../../agent/extract';

/** A topic translated into the literature's vocabulary. `core` is the central mechanism plus synonyms
 * (the recall driver); `context` is optional population/domain terms. Built once per topic, then
 * rendered into each source's query syntax by the per-source adapters. */
export interface Concepts {
  core: string[];
  context: string[];
}

const STOP = new Set(['and', 'for', 'the', 'with', 'from', 'after', 'during', 'into', 'that', 'this']);

/** Quote multi-word phrases so they search as a unit; leave single words bare. Shared by the
 * PubMed and Europe PMC query adapters so their phrase-quoting can't drift. */
export function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/** Distinct lowercase content words of a topic (≥3 chars, minus a few grammar words). The deterministic
 * fallback when the LLM rewrite is unavailable — a search still runs, just without synonym expansion. */
export function topicTerms(topic: string): string[] {
  const toks = topic.toLowerCase().split(/\W+/).filter((t) => t.length >= 3 && !STOP.has(t));
  return [...new Set(toks)];
}

/**
 * Map a gaming-flavoured topic to the vocabulary papers actually use. One `research-triage` LLM call
 * turns e.g. "tilt emotion regulation competitive gaming" into core mechanism phrases + synonyms
 * ("emotion regulation", "cognitive reappraisal", "frustration/anger regulation") plus optional domain
 * context ("video gaming", "esports"). Fail-open: any error/empty/garbage → the raw content terms with
 * no context, so a search always runs. Provider resolved lazily inside `generate` (CLAUDE.md rule).
 */
export async function topicToConcepts(topic: string): Promise<Concepts> {
  try {
    const { text } = await generate('research-triage', {
      prompt:
        `Rewrite this research topic into search concepts for biomedical/psychology literature.\n` +
        `- "core": the central mechanism PLUS 2-5 synonyms / related clinical terms, as phrases a paper ` +
        `would use — NOT the user's slang (e.g. "tilt" -> "frustration regulation", "anger regulation", ` +
        `"emotion regulation under stress").\n` +
        `- "context": optional population/domain words (e.g. "video gaming", "esports"); may be empty.\n` +
        `Return ONLY JSON: {"core": string[], "context": string[]}.\n\n` +
        `Topic: ${topic}`,
      maxOutputTokens: triageMaxTokens(),
      temperature: 0,
    });
    const parsed = JSON.parse(stripFences((text ?? '').trim())) as Partial<Concepts>;
    const clean = (xs: unknown): string[] =>
      Array.isArray(xs) ? xs.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [];
    const core = clean(parsed.core);
    if (core.length === 0) return { core: topicTerms(topic), context: [] };
    return { core, context: clean(parsed.context) };
  } catch {
    return { core: topicTerms(topic), context: [] };
  }
}
