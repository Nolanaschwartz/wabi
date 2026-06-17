import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ResearchConfigService } from '../config-service/research-config.service';
import { ResearchRunnerService } from './research-runner.service';
import { Bounds } from '../types';

/** The pg-boss queue the worker schedules (slice 04) AND consumes (this slice). */
export const RESEARCH_RUN_QUEUE = 'research-run';

/** What fired a run. */
export type RunTrigger = 'scheduled' | 'manual';

/** Shape of the job payload the consumer reads. Both fields are optional. */
interface RunJobPayload {
  /** Present when a manual "Run now" already created the `running` row; the consumer finalizes it. */
  runId?: string;
  /** What fired the run. Absent on a scheduled firing → defaults to 'scheduled'. */
  trigger?: RunTrigger;
}

/** Default and ceiling for the recent-runs list size. */
const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;

/** The ResearchConfig singleton row id (matches ResearchConfigService). */
const CONFIG_SINGLETON_ID = 'singleton';

/**
 * Fallback staleness threshold (the schema default for `ResearchConfig.runTimeoutMs`). Used when the
 * config row can't be read — the guard must never throw, so it degrades to this sane default.
 */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/**
 * Schema-default bounds (mirrors `ResearchConfig`'s `@default`s). Used when the config singleton
 * can't be read — the run must still proceed with sane bounds rather than crash, since the row read
 * is the worker's source of truth but the run is non-critical and degrades, never throws.
 */
const DEFAULT_BOUNDS: Bounds = {
  maxTopicsPerRun: 5,
  maxPapersPerTopic: 8,
  maxDiscoverySteps: 2,
  maxDraftsPerTopic: 3,
  maxDraftsPerRun: 10,
  agentTimeoutMs: 90_000,
  runTimeoutMs: 600_000,
  tokenBudget: 200_000,
};

/** The eight bounds columns on the ResearchConfig singleton. */
type ConfigBounds = Partial<Record<keyof Bounds, number>>;

/**
 * Owns the `research-run` queue's consumer and the ResearchRun lifecycle (issue 05, ADR-0034).
 *
 * The handler runs the REAL research loop (slice 06): it inserts a `running` ResearchRun row carrying
 * the firing trigger, loads the enabled topics + the eight bounds from the DATABASE (the source of
 * truth — not env, not SEED_TOPICS), delegates the search→gate→extract→dedup→submit work to
 * {@link ResearchRunnerService} (which wraps the pure `runResearch` core and POSTs every candidate
 * through the bot's trust gate), then finalizes the row with the real summary counts + stop reason.
 * A failure anywhere finalizes the row to `failed` with the error captured, which also releases
 * single-flight.
 *
 * Single-flight uses BOTH guards the issue calls for:
 *   (a) the pg-boss singleton queue — `work(..., { policy: 'singleton' })` keeps one job active.
 *   (b) a secondary DB guard — before creating a new `running` row we check for an existing one and
 *       collapse if found. This covers the manual path (which creates its row BEFORE enqueueing) and
 *       the window where a scheduled firing races a manual run.
 *
 * Isolation: touches ONLY ResearchRun + the research-run queue — never User or StrategyDraft.
 * Fail-safe: research is non-critical, so DB/pg-boss outages degrade to no-ops, never a 500.
 */
@Injectable()
export class ResearchRunService implements OnModuleInit {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly config: ResearchConfigService,
    private readonly runner: ResearchRunnerService,
  ) {}

  /**
   * Register the singleton consumer on boot. The pg-boss singleton policy is the primary
   * single-flight guard; the bound handler runs the real research loop. No-op when degraded
   * (SchedulerService.work is a no-op without a pg-boss client).
   */
  async onModuleInit(): Promise<void> {
    await this.scheduler.work(RESEARCH_RUN_QUEUE, (jobs) => this.onJobs(jobs), {
      policy: 'singleton',
    });
  }

  /** pg-boss delivers a batch of jobs; run the real research loop for each. */
  private async onJobs(jobs: unknown[]): Promise<void> {
    for (const job of jobs) {
      const data = (job as { data?: RunJobPayload })?.data ?? (job as RunJobPayload) ?? {};
      await this.handleJob(data);
    }
  }

  /**
   * The real-run handler. Resolves the firing trigger (default 'scheduled'); enforces the DB
   * single-flight guard; creates-or-reuses the `running` row; runs the research loop; then finalizes
   * the row with the real summary.
   *
   * - When the payload carries a `runId` (manual path), the `running` row already exists — finalize
   *   it rather than creating a second one.
   * - Otherwise (scheduled firing) create the row here, unless a `running` row already exists, in
   *   which case collapse (do nothing) — the DB secondary guard.
   *
   * On ANY failure during the run the row is finalized to `failed` with a short error message, which
   * also releases single-flight. Research is non-critical (ADR-0034) — this never crashes the worker.
   */
  async handleJob(payload: RunJobPayload): Promise<void> {
    const trigger: RunTrigger = payload.trigger ?? 'scheduled';

    let runId = payload.runId ?? null;

    if (!runId) {
      // Scheduled firing: collapse if a run is already active (secondary DB guard).
      const active = await this.findActiveRun();
      if (active) return;
      const created = await prisma.researchRun.create({
        data: { trigger, status: 'running' },
      });
      runId = (created as { id: string }).id;
    }

    try {
      // The DB is the source of truth: enabled topics + the eight bounds drive the run (NOT env,
      // NOT SEED_TOPICS, NOT loadBounds()).
      const [topics, bounds] = await Promise.all([this.loadTopics(), this.loadBounds()]);

      const result = await this.runner.execute({ topics, bounds });

      await prisma.researchRun.update({
        where: { id: runId },
        data: {
          status: 'success',
          finishedAt: new Date(),
          submitted: result.submitted,
          deduped: result.deduped,
          rejected: result.rejected,
          errors: result.errors,
          collected: result.collected,
          tokensUsed: result.tokensUsed,
          topicsRun: result.topicsRun,
          stopReason: result.stopReason,
        },
      });
    } catch (err) {
      // Fail-closed for the run, fail-open for the worker: finalize to `failed` (releasing
      // single-flight) and swallow — a research run blowing up must never take the process down.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[research] run failed; finalizing row to failed', err);
      await prisma.researchRun
        .update({
          where: { id: runId },
          data: { status: 'failed', finishedAt: new Date(), error: message.slice(0, 500) },
        })
        .catch((finalizeErr) =>
          console.error('[research] failed to finalize failed run row', finalizeErr),
        );
    }
  }

  /** Enabled topic texts from the DB (the source of truth). Empty list ⇒ the run does nothing. */
  private async loadTopics(): Promise<string[]> {
    const rows = (await this.config.getEnabledTopics()) as Array<{ text?: string }>;
    return rows.map((r) => r.text).filter((t): t is string => typeof t === 'string' && t.length > 0);
  }

  /**
   * The eight run bounds from the ResearchConfig singleton, mapped into the {@link Bounds} shape the
   * core expects. Falls back to the schema defaults when the singleton can't be read — the run must
   * degrade, never throw.
   */
  private async loadBounds(): Promise<Bounds> {
    let config: ConfigBounds | null = null;
    try {
      config = (await prisma.researchConfig.findUnique({
        where: { id: CONFIG_SINGLETON_ID },
      })) as ConfigBounds | null;
    } catch (err) {
      console.error('[research] reading bounds failed; using schema defaults', err);
    }
    if (!config) return DEFAULT_BOUNDS;

    const pick = (key: keyof Bounds): number => {
      const value = config?.[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_BOUNDS[key];
    };
    return {
      maxTopicsPerRun: pick('maxTopicsPerRun'),
      maxPapersPerTopic: pick('maxPapersPerTopic'),
      maxDiscoverySteps: pick('maxDiscoverySteps'),
      maxDraftsPerTopic: pick('maxDraftsPerTopic'),
      maxDraftsPerRun: pick('maxDraftsPerRun'),
      agentTimeoutMs: pick('agentTimeoutMs'),
      runTimeoutMs: pick('runTimeoutMs'),
      tokenBudget: pick('tokenBudget'),
    };
  }

  /**
   * Manual "Run now". Reconciles with single-flight: if a `running` row already exists, return THAT
   * row's id (collapsed — no second row, no enqueue). Otherwise create the `running` ResearchRun row
   * with trigger 'manual', enqueue `send('research-run', { runId, trigger:'manual' })`, and return
   * its id. The consumer finalizes the existing row (it sees the runId in the payload).
   *
   * Fail-safe: if the DB write throws (degraded), return `{ runId: null }` so the operator gets a
   * clear no-op rather than a 500 stack trace.
   *
   * Fix 1 (ADR-0034): the `running` row is created BEFORE the enqueue, so if `send()` throws after
   * a successful create the row would otherwise orphan as `running` and jam single-flight forever.
   * We finalize that row to `failed` before returning the degraded result, releasing the guard so
   * the next trigger can proceed. This is kept distinct from the create-itself-failed path (no row
   * exists there, so there is nothing to release).
   */
  async triggerManualRun(): Promise<{ runId: string | null }> {
    let createdRunId: string | null = null;
    try {
      const active = await this.findActiveRun();
      if (active) return { runId: (active as { id: string }).id };

      const created = await prisma.researchRun.create({
        data: { trigger: 'manual', status: 'running' },
      });
      createdRunId = (created as { id: string }).id;
      await this.scheduler.send(RESEARCH_RUN_QUEUE, { runId: createdRunId, trigger: 'manual' });
      return { runId: createdRunId };
    } catch (err) {
      console.error('[research] manual run enqueue failed; degraded no-op', err);
      // If the row was created but the enqueue failed, release single-flight by finalizing it to
      // `failed` — otherwise the orphaned `running` row jams every future trigger.
      if (createdRunId) {
        await prisma.researchRun
          .update({
            where: { id: createdRunId },
            data: { status: 'failed', finishedAt: new Date(), error: 'enqueue failed' },
          })
          .catch((finalizeErr) =>
            console.error('[research] failed to finalize orphaned running row', finalizeErr),
          );
      }
      return { runId: null };
    }
  }

  /** Recent runs, newest first, with the limit clamped to a sane range. Empty list when degraded. */
  async listRuns(limit?: number): Promise<unknown[]> {
    const take = this.clampLimit(limit);
    try {
      return await prisma.researchRun.findMany({
        orderBy: { startedAt: 'desc' },
        take,
      });
    } catch (err) {
      console.error('[research] listRuns failed; returning empty (degraded)', err);
      return [];
    }
  }

  /**
   * The secondary single-flight guard: the currently-active run, if any.
   *
   * Fix 2 (ADR-0034): a crash between creating the `running` row and finalizing it would otherwise
   * leave a permanent `running` row that wedges single-flight. So a `running` row whose `startedAt`
   * predates `now - runTimeoutMs` is treated as stale/abandoned and does NOT count as active — it is
   * reaped (best-effort finalized to `failed`) and a new run is allowed to proceed. The staleness
   * threshold is read lazily from the ResearchConfig singleton per call (never cached); if that read
   * fails we fall back to the schema default so the guard never throws.
   */
  private async findActiveRun(): Promise<unknown | null> {
    const active = await prisma.researchRun.findFirst({ where: { status: 'running' } });
    if (!active) return null;

    const startedAt = (active as { startedAt?: Date | string | null }).startedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    if (Number.isNaN(startedMs)) return active; // no usable timestamp → treat as active (safe).

    const timeoutMs = await this.resolveRunTimeoutMs();
    const isStale = startedMs < Date.now() - timeoutMs;
    if (!isStale) return active;

    // Reap the abandoned row so history reflects reality and the guard is released.
    await prisma.researchRun
      .update({
        where: { id: (active as { id: string }).id },
        data: { status: 'failed', finishedAt: new Date(), error: 'timed out' },
      })
      .catch((err) => console.error('[research] failed to reap stale running row', err));
    return null;
  }

  /**
   * Read the staleness threshold (`runTimeoutMs`) from the ResearchConfig singleton, lazily, per
   * call. Falls back to the schema default on any failure — this is a guard helper and must never
   * throw.
   */
  private async resolveRunTimeoutMs(): Promise<number> {
    try {
      const config = await prisma.researchConfig.findUnique({ where: { id: CONFIG_SINGLETON_ID } });
      const value = (config as { runTimeoutMs?: number } | null)?.runTimeoutMs;
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_RUN_TIMEOUT_MS;
    } catch (err) {
      console.error('[research] reading runTimeoutMs failed; using default threshold', err);
      return DEFAULT_RUN_TIMEOUT_MS;
    }
  }

  /** Clamp the requested limit to [1, MAX]; a missing/non-positive value falls back to the default. */
  private clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_RUNS_LIMIT;
    return Math.min(Math.floor(limit), MAX_RUNS_LIMIT);
  }
}
