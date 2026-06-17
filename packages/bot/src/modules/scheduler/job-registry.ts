import { Injectable } from '@nestjs/common';
import type { JobDefinition } from './jobs';

/**
 * The single place every scheduled job is declared. Owning services push a `JobDefinition` here from
 * their `onModuleInit` (a pure, pg-boss-free act, so it is order-independent); the Scheduler drains
 * the registry once at application bootstrap and registers each job, recording the outcome.
 *
 * Before this, each owner called `scheduler.cron`/`work` directly with its own queue string, and a
 * failed registration vanished into a best-effort `catch {}`. The registry makes the job set legible
 * in one list and the registration outcome observable (see `SchedulerService.jobStatus`).
 */
@Injectable()
export class JobRegistry {
  private readonly jobs: JobDefinition[] = [];

  declare(def: JobDefinition): void {
    this.jobs.push(def);
  }

  all(): JobDefinition[] {
    return this.jobs;
  }
}
