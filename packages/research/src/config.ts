import { Bounds } from './types';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
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
