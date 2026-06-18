import { Bounds, Candidate, RunSummary } from './types';
import { SubmitOutcome } from './bot-client';
import { Logger, noopLogger } from './util/logger';

export interface RunDeps {
  topics: string[];
  bounds: Bounds;
  runAgent: (topic: string) => Promise<{ candidates: Candidate[]; summary: Partial<RunSummary>; tokens: number }>;
  /** Submit all drafts mined from ONE paper in a single call; returns a per-draft outcome. */
  submitBatch: (candidates: Candidate[]) => Promise<SubmitOutcome[]>;
  /** Injectable clock for deadline enforcement; defaults to Date.now. */
  now?: () => number;
  /** Optional progress logger; defaults to a no-op so tests stay silent. */
  log?: Logger;
}

/** Group a topic's candidates by their source paper, preserving first-seen order. One paper may now
 * yield several drafts; they are submitted together so the bot marks the per-source ledger once. */
function groupBySource(candidates: Candidate[]): Candidate[][] {
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const group = byId.get(c.sourceId);
    if (group) group.push(c);
    else byId.set(c.sourceId, [c]);
  }
  return [...byId.values()];
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

  let capped = false;
  for (const topic of topics) {
    if (now() >= deadline) { result.stopReason = 'runTimeout'; log.info('run stop', { reason: 'runTimeout' }); break; }
    if (result.collected >= deps.bounds.maxDraftsPerRun) { result.stopReason = 'maxDraftsPerRun'; log.info('run stop', { reason: 'maxDraftsPerRun' }); break; }
    const { candidates } = await deps.runAgent(topic);
    // The cap is checked at paper boundaries: a paper that starts submits all of its drafts (kept
    // atomic so the ledger mark and batch outcome stay consistent), but no new paper starts once hit.
    for (const paper of groupBySource(candidates)) {
      if (result.collected >= deps.bounds.maxDraftsPerRun) { result.stopReason = 'maxDraftsPerRun'; capped = true; break; }
      const outcomes = await deps.submitBatch(paper);
      outcomes.forEach((outcome, i) => {
        result.collected++;
        if (outcome === 'submitted') result.submitted++;
        else if (outcome === 'deduped') result.deduped++;
        else if (outcome === 'rejected') result.rejected++;
        else result.errors++;
        log.info('submit', { title: paper[i]?.title, outcome });
      });
    }
    if (capped) { log.info('run stop', { reason: 'maxDraftsPerRun' }); break; }
  }
  log.info('run done', { ...result });
  return result;
}
