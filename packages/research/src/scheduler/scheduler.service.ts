import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

export type JobHandler = (jobs: unknown[]) => Promise<void>;

/** pg-boss schedule options we use — just the timezone the cron is interpreted in. */
export interface ScheduleOptions {
  tz?: string;
}

/**
 * Options for binding a worker. `policy` sets the queue policy at creation time. We use
 * `'singleton'` for `research-run`: pg-boss then keeps at most one job *active* at a time
 * (unlimited queued), which is the primary single-flight guard for a research run.
 */
export interface WorkOptions {
  policy?: 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive';
}

/**
 * The research worker's single pg-boss client and job seam (ADR-0034). Ported from the bot's
 * SchedulerService and kept to the same posture: one PgBoss client, one lifecycle, fail-closed.
 *
 * Fails closed like the rest of the worker: if DATABASE_URL is absent or pg-boss can't start, the
 * client stays null and every op is a no-op — the worker still boots (research is non-critical).
 * Callers that must branch on degraded mode read `available`. (Adds `unschedule`, which the bot's
 * copy lacks, because reconciling a schedule means being able to remove it too.)
 */
@Injectable()
export class SchedulerService {
  private boss: PgBoss | null = null;

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

  /**
   * Bind a worker to a queue (creating it). When `options.policy` is given the queue is created
   * with that policy (e.g. `'singleton'` for single-flight). No-op when degraded.
   */
  async work(queue: string, handler: JobHandler, options?: WorkOptions): Promise<void> {
    if (!this.boss) return;
    try {
      if (options?.policy) {
        await this.boss.createQueue(queue, { policy: options.policy });
      } else {
        await this.boss.createQueue(queue);
      }
      await this.boss.work(queue, handler);
    } catch {
      // best-effort registration
    }
  }

  /** Enqueue a one-off job on a queue. No-op when degraded. */
  async send(queue: string, data: object): Promise<void> {
    if (!this.boss) return;
    await this.boss.send(queue, data);
  }

  /**
   * Schedule (or reschedule) a recurring cron job with a payload. pg-boss upserts the schedule by
   * queue name, so calling this again with a new cron replaces the prior entry. `options.tz` sets
   * the timezone the cron is interpreted in. No-op when degraded.
   */
  async schedule(
    queue: string,
    cron: string,
    data: object,
    options?: ScheduleOptions,
  ): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.schedule(queue, cron, data, options);
    } catch {
      // best-effort schedule
    }
  }

  /** Remove the recurring schedule for a queue. No-op when degraded. */
  async unschedule(queue: string): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.unschedule(queue);
    } catch {
      // best-effort unschedule
    }
  }
}
