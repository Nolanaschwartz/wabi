import { Bounds, Candidate, RunSummary } from './types';
import { SubmitOutcome } from './bot-client';
import { Logger, noopLogger } from './util/logger';

export interface RunDeps {
  topics: string[];
  bounds: Bounds;
  runAgent: (topic: string) => Promise<{ candidates: Candidate[]; summary: Partial<RunSummary>; tokens: number }>;
  submit: (candidate: Candidate) => Promise<SubmitOutcome>;
  /** Injectable clock for deadline enforcement; defaults to Date.now. */
  now?: () => number;
  /** Optional progress logger; defaults to a no-op so tests stay silent. */
  log?: Logger;
}

export interface RunResult { submitted: number; deduped: number; rejected: number; errors: number; collected: number; stopReason: string }

/**
 * Pure run core: iterate topics under the run budget, submit collected candidates, tally outcomes.
 *
 * This is the heart the worker wraps — {@link ResearchRunnerService} builds the production
 * `runAgent`/`submit` deps and drives this loop, then {@link ResearchRunService} persists the
 * result. The Nest worker is the only runner (ADR-0034).
 */
export async function runResearch(deps: RunDeps): Promise<RunResult> {
  const result: RunResult = { submitted: 0, deduped: 0, rejected: 0, errors: 0, collected: 0, stopReason: 'exhausted' };
  const log = deps.log ?? noopLogger;
  const topics = deps.topics.slice(0, deps.bounds.maxTopicsPerRun);
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deps.bounds.runTimeoutMs;
  log.info('run start', { topics: topics.length, maxDraftsPerRun: deps.bounds.maxDraftsPerRun });

  for (const topic of topics) {
    if (now() >= deadline) { result.stopReason = 'runTimeout'; log.info('run stop', { reason: 'runTimeout' }); break; }
    if (result.collected >= deps.bounds.maxDraftsPerRun) { result.stopReason = 'maxDraftsPerRun'; log.info('run stop', { reason: 'maxDraftsPerRun' }); break; }
    const { candidates } = await deps.runAgent(topic);
    for (const candidate of candidates) {
      if (result.collected >= deps.bounds.maxDraftsPerRun) break;
      result.collected++;
      const outcome = await deps.submit(candidate);
      if (outcome === 'submitted') result.submitted++;
      else if (outcome === 'deduped') result.deduped++;
      else if (outcome === 'rejected') result.rejected++;
      else result.errors++;
      log.info('submit', { title: candidate.title, outcome });
    }
  }
  log.info('run done', { ...result });
  return result;
}
