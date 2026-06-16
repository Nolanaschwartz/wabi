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
