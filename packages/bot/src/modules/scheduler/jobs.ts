import type { JobHandler } from './scheduler.service';

/**
 * The canonical name of every pg-boss job in the bot. Imported at BOTH the registration site (the
 * owning service's `declare`) and the enqueue site (`scheduler.send`/`sendAfter`), so a producer and
 * its consumer can never drift onto different queue strings — the bug a scattered set of raw literals
 * and per-module consts invited.
 */
export enum Job {
  CrisisFollowUp = 'crisis-follow-up',
  CheckIn = 'check-in-scheduler',
  StrategyDemote = 'strategy-demote',
  StrategyReconcile = 'strategy-reconcile',
  SessionSweep = 'session-sweeper',
  TiltAutoResolve = 'tilt-auto-resolve',
}

/**
 * One declared job. `cron` is required when `kind` is `'cron'` and absent for a `'work'` queue (a
 * one-off worker fed by `send`/`sendAfter`). `owner` is the declaring module, surfaced on `/health`
 * so a failed registration names the module to look at. `handler` is the instance-bound worker — it
 * closes over its service, which is why a job is declared from the owner's `onModuleInit`, not from a
 * static table.
 */
export type JobDefinition =
  | { name: Job; kind: 'cron'; cron: string; owner: string; handler: JobHandler }
  | { name: Job; kind: 'work'; owner: string; handler: JobHandler };
