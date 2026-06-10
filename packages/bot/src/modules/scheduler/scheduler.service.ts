import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

export type JobHandler = (jobs: unknown[]) => Promise<void>;

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
