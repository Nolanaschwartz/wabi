function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export type SourceKindName = 'pubmed' | 'psyarxiv' | 'europepmc';

/** One source knob with a 3-tier fallback: per-source `RESEARCH_<KIND>_<KEY>` overrides shared
 * `RESEARCH_<KEY>` overrides the built-in default. Empty/invalid values fall through to the next
 * tier (so `FOO=` doesn't silently mean 0). Resolved lazily per call — never frozen at import. */
function sourceNum(kind: SourceKindName, key: string, fallback: number): number {
  const raw = process.env[`RESEARCH_${kind.toUpperCase()}_${key}`] ?? process.env[`RESEARCH_${key}`];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : fallback;
}

/** Full-text char cap for any source (PubMed has no window/PDF knobs, just this). Shares the same
 * `RESEARCH_MAX_TEXT_CHARS` fallback as the preprint sources. */
export function sourceMaxTextChars(kind: SourceKindName): number {
  return sourceNum(kind, 'MAX_TEXT_CHARS', 50_000);
}

/** Full-text download byte cap (oversize -> abstract fallback), shared across the preprint sources
 * with the same 3-tier `RESEARCH_MAX_DOC_BYTES` / `RESEARCH_<KIND>_MAX_DOC_BYTES` fallback. Caps both
 * PDF and DOCX downloads. Resolved lazily per call — never frozen at import. */
export function sourceMaxDocBytes(kind: SourceKindName): number {
  return sourceNum(kind, 'MAX_DOC_BYTES', 20_000_000);
}

// Run Bounds (caps + defaults + ranges) now live in run-bounds.ts, sourced from the ResearchConfig
// singleton via ResearchConfigService.loadRunBounds() (ADR-0034). The old env-only loadBounds() is gone.

// LLM output-token caps, resolved lazily per call (CLAUDE.md: never freeze env-derived state).
// These MUST be generous: a reasoning model spends hidden reasoning tokens out of the same output
// budget, so a 5-token cap returns EMPTY visible text and the call silently no-ops. Verified against
// the local qwopus-3.6 MTP model — gate/dedup needed ~2k and extract ~4k to emit any answer at all.

/** Output cap for the cheap triage calls (relevance gate + in-run dedup). */
export function triageMaxTokens(): number {
  return num('RESEARCH_TRIAGE_MAX_TOKENS', 2000);
}

/** Output cap for the extract call (must fit reasoning + a full JSON technique object). Sized to the
 * per-call context window (≈131k/3 ≈ 43.6k on the local tier) minus the body, ~5% buffer — a 4k cap
 * let the reasoning model's hidden tokens crowd out the JSON, surfacing as false "no candidate"s. */
export function extractMaxTokens(): number {
  return num('RESEARCH_MAX_TOKENS', 28_000);
}
