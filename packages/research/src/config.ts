import { Bounds } from './types';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export type SourceKindName = 'pubmed' | 'medrxiv' | 'psyarxiv';

/** Tunable knobs shared by the windowed preprint sources (medRxiv, PsyArXiv). */
export interface SourceConfig {
  windowDays: number;      // recency window scanned
  maxRecords: number;      // per-window scan cap
  minTermFraction: number; // fraction of query content-terms a record must match (>2-term queries)
  maxPdfBytes: number;     // full-text PDF download cap
  maxTextChars: number;    // extracted full-text char cap
}

/** One source knob with a 3-tier fallback: per-source `RESEARCH_<KIND>_<KEY>` overrides shared
 * `RESEARCH_<KEY>` overrides the built-in default. Empty/invalid values fall through to the next
 * tier (so `FOO=` doesn't silently mean 0). Resolved lazily per call — never frozen at import. */
function sourceNum(kind: SourceKindName, key: string, fallback: number): number {
  const raw = process.env[`RESEARCH_${kind.toUpperCase()}_${key}`] ?? process.env[`RESEARCH_${key}`];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : fallback;
}

/** Windowed preprint-source tuning, resolved lazily per run. */
export function loadSourceConfig(kind: 'medrxiv' | 'psyarxiv'): SourceConfig {
  return {
    windowDays: sourceNum(kind, 'WINDOW_DAYS', 60),
    maxRecords: sourceNum(kind, 'MAX_RECORDS', 1500),
    minTermFraction: sourceNum(kind, 'MIN_TERM_FRACTION', 0.5),
    maxPdfBytes: sourceNum(kind, 'MAX_PDF_BYTES', 20_000_000),
    maxTextChars: sourceNum(kind, 'MAX_TEXT_CHARS', 50_000),
  };
}

/** Full-text char cap for any source (PubMed has no window/PDF knobs, just this). Shares the same
 * `RESEARCH_MAX_TEXT_CHARS` fallback as the preprint sources. */
export function sourceMaxTextChars(kind: SourceKindName): number {
  return sourceNum(kind, 'MAX_TEXT_CHARS', 50_000);
}

/** Conservative, configurable bounds (spec §Bounds & budget). Resolved lazily per run. */
export function loadBounds(): Bounds {
  return {
    maxTopicsPerRun: num('RESEARCH_MAX_TOPICS_PER_RUN', 5),
    maxPapersPerTopic: num('RESEARCH_MAX_PAPERS_PER_TOPIC', 8),
    maxDiscoverySteps: num('RESEARCH_MAX_DISCOVERY_STEPS', 2),
    maxDraftsPerTopic: num('RESEARCH_MAX_DRAFTS_PER_TOPIC', 3),
    maxDraftsPerRun: num('RESEARCH_MAX_DRAFTS_PER_RUN', 10),
    agentTimeoutMs: num('RESEARCH_AGENT_TIMEOUT_MS', 90_000),
    runTimeoutMs: num('RESEARCH_RUN_TIMEOUT_MS', 600_000),
    tokenBudget: num('RESEARCH_TOKEN_BUDGET', 200_000),
  };
}

// LLM output-token caps, resolved lazily per call (CLAUDE.md: never freeze env-derived state).
// These MUST be generous: a reasoning model spends hidden reasoning tokens out of the same output
// budget, so a 5-token cap returns EMPTY visible text and the call silently no-ops. Verified against
// the local qwopus-3.6 MTP model — gate/dedup needed ~2k and extract ~4k to emit any answer at all.

/** Output cap for the cheap triage calls (relevance gate + in-run dedup). */
export function triageMaxTokens(): number {
  return num('RESEARCH_TRIAGE_MAX_TOKENS', 2000);
}

/** Output cap for the extract call (must fit reasoning + a full JSON technique object). */
export function extractMaxTokens(): number {
  return num('RESEARCH_MAX_TOKENS', 4000);
}
