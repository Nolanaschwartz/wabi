import { Paper, Candidate, Lens, SourceKind } from '../types';
import type { ResearchGenerate } from './research-generate';
import { evidenceTag, evidenceTier, stripFences } from './extract';
import { SCOPE_FRAGMENT } from './scope-policy';

/** Human-readable source label carried on each Candidate (display + provenance), set from the source. */
const SOURCE_LABEL: Record<SourceKind, string> = {
  pubmed: 'PubMed',
  medrxiv: 'medRxiv (preprint)',
  psyarxiv: 'PsyArXiv (preprint)',
  europepmc: 'Europe PMC (preprint)',
};

export interface LensExtractResult {
  candidates: Candidate[];
  tokens: number;
}

/** Extract a source body's techniques in ONE call (slice 05). The body is sent once — not re-sent per
 * lens — and the model tags each technique with the lens whose primary mechanism it reflects, drawn
 * from the tier-scaled `lenses` set (full breadth for peer-reviewed, the narrower subset for preprints).
 * The guards are non-negotiable: sourceText must be a verbatim substring (hallucination guard), the lens
 * must be one we asked for, wording stays audience-neutral, the scope fragment excludes supplement/
 * clinical techniques, and the tier is set from the source, never the model. Fail-open (ADR-0021): a
 * malformed/empty reply yields no candidates and never aborts the run. */
export async function extractWithLenses(gen: ResearchGenerate, paper: Paper, body: string, lenses: Lens[]): Promise<LensExtractResult> {
  const allowed = new Set<Lens>(lenses);

  let out;
  try {
    out = await gen('extract', 'research', {
      prompt:
        `Extract every transferable, actionable coping/wellbeing technique the source describes.\n` +
        `${SCOPE_FRAGMENT}\n` +
        `Tag each technique with the SINGLE lens whose primary mechanism it reflects, chosen from: ` +
        `${lenses.join(', ')}. Skip any technique that does not fit one of those lenses.\n` +
        `Rules:\n` +
        `- "title" MUST be short, plain, and action-oriented (what the person does) — not an academic label.\n` +
        `- Write each technique in audience-neutral language. Do NOT mention games, gamers, ranked, ` +
        `tilt, or any specific population — describe the general mechanism only.\n` +
        `- Each "sourceText" MUST be a verbatim quote copied exactly from the source (a real substring).\n` +
        `- "lens" MUST be exactly one of: ${lenses.join(', ')}.\n` +
        `Return JSON array: [{"title": string, "technique": string, "sourceText": string, "lens": string}] (or []).\n\n` +
        `Source:\n${body}`,
    });
  } catch {
    return { candidates: [], tokens: 0 };
  }

  const tokens = out.usage?.totalTokens ?? 0;
  const text = stripFences(out.text.trim());
  if (text === '' || text.toLowerCase() === 'null') return { candidates: [], tokens };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { candidates: [], tokens };
  }
  if (!Array.isArray(parsed)) return { candidates: [], tokens };

  const candidates: Candidate[] = [];
  for (const item of parsed as { title?: string; technique?: string; sourceText?: string; lens?: Lens }[]) {
    const { title, technique, sourceText, lens } = item ?? {};
    if (!title || !technique || !sourceText || !lens) continue;
    const lensNorm = String(lens).toLowerCase() as Lens; // tolerate "Behavioral"/casing from the model
    if (!allowed.has(lensNorm)) continue;        // only lenses we asked for
    if (!body.includes(sourceText)) continue;    // verbatim-substring hallucination guard
    candidates.push({
      title,
      technique,
      sourceText,
      evidence: evidenceTag(paper),
      evidenceTier: evidenceTier(paper),
      sourceUrl: paper.url,
      source: SOURCE_LABEL[paper.sourceKind],
      sourceId: paper.sourceId,
      sourceKind: paper.sourceKind,
      trustLevel: 'research-agent',
      lens: lensNorm,
    });
  }
  return { candidates, tokens };
}
