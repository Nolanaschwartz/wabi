import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { JobRegistry } from './job-registry';
import type { JobDefinition } from './jobs';
import { Job } from './jobs';

export type JobHandler = (jobs: unknown[]) => Promise<void>;

/** Per-job registration outcome, surfaced on `/health`. A job sits in exactly one bucket. */
export interface JobStatus {
  /** Bound to a live worker. */
  registered: Job[];
  /** Declared but not bound — the client is degraded (no DB). Not an error; the bot still boots. */
  degraded: Job[];
  /** Declared, the client was up, but binding threw. The one bucket an operator must act on. */
  failed: Job[];
}

/**
 * The bot's single pg-boss client and job seam. Before this, five services each constructed their
 * own `new PgBoss(connectionString)` — five connection pools and five copies of start/createQueue/
 * work/stop + graceful-degradation. They now register through one Scheduler: one pool, one
 * lifecycle, connection tuning in one place.
 *
 * Fails closed like everything else: if DATABASE_URL is absent or pg-boss can't start, the client
 * stays null and every register/enqueue call is a no-op (the bot still comes online, ADR-0019/0021).
 * Callers that must branch on degraded mode read `available`.
 */
@Injectable()
export class SchedulerService {
  private boss: PgBoss | null = null;
  private readonly status: JobStatus = { registered: [], degraded: [], failed: [] };

  /** The outcome of the last `drainRegistry` — what bound, what degraded, what failed. */
  get jobStatus(): JobStatus {
    return this.status;
  }

  /**
   * Register every job declared in the registry, recording each outcome. Run once at application
   * bootstrap, AFTER every owner has declared (so it doesn't depend on module init order). Degraded
   * client ⇒ every job is marked degraded and nothing binds (fail-open). A single job that throws on
   * bind is marked failed and the rest still register — one bad worker never sinks the others.
   */
  async drainRegistry(registry: JobRegistry): Promise<void> {
    for (const def of registry.all()) {
      if (!this.boss) {
        this.status.degraded.push(def.name);
        continue;
      }
      try {
        await this.bind(def);
        this.status.registered.push(def.name);
      } catch {
        this.status.failed.push(def.name);
      }
    }
  }

  /** Bind one declared job to the live client. Throws on failure so `drainRegistry` can record it. */
  private async bind(def: JobDefinition): Promise<void> {
    if (!this.boss) return;
    await this.boss.createQueue(def.name);
    if (def.kind === 'cron') {
      await this.boss.schedule(def.name, def.cron);
    }
    await this.boss.work(def.name, def.handler);
  }

  /** True once the shared client has started; false in degraded mode (no DB / start failed). */
  get available(): boolean {
    return this.boss !== null;
  }

  async start(): Promise<void> {
    if (!process.env.DATABASE_URL) return;
    try {
      this.boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
      await this.boss.start();
    } catch {
      this.boss = null;
    }
  }

  async stop(): Promise<void> {
    if (this.boss) {
      await this.boss.stop();
      this.boss = null;
    }
  }

  /** Bind a worker to a queue (creating it). No-op when degraded. */
  async work(queue: string, handler: JobHandler): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.createQueue(queue);
      await this.boss.work(queue, handler);
    } catch {
      // best-effort registration
    }
  }

  /** Bind a recurring cron worker to a queue (creating it). No-op when degraded. */
  async cron(queue: string, cronExpr: string, handler: JobHandler): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.createQueue(queue);
      await this.boss.schedule(queue, cronExpr);
      await this.boss.work(queue, handler);
    } catch {
      // best-effort registration
    }
  }

  /**
   * Enqueue a one-off job on a queue. No-op when degraded (check `available` first if you need to
   * know). Unlike the registration helpers, a real enqueue failure PROPAGATES — callers that want a
   * synchronous fallback (e.g. strategy demote) depend on catching it.
   */
  async send(queue: string, data: object): Promise<void> {
    if (!this.boss) return;
    await this.boss.send(queue, data);
  }

  /** Schedule a recurring job with a pg-boss cron expression + payload. No-op when degraded. */
  async schedule(queue: string, cronOrInterval: string, data: object): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.schedule(queue, cronOrInterval, data);
    } catch {
      // best-effort schedule
    }
  }

  /**
   * Enqueue a ONE-OFF job to run after a delay (seconds) — the right primitive for a delayed
   * follow-up (pg-boss `schedule` is for recurring crons, not a single deferred run). Best-effort;
   * no-op when degraded.
   */
  async sendAfter(queue: string, data: object, startAfterSeconds: number): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.send(queue, data, { startAfter: startAfterSeconds });
    } catch {
      // best-effort enqueue
    }
  }
}
