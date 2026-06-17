import { Injectable } from '@nestjs/common';
import type { JobDefinition } from './jobs';

/**
 * The single place every scheduled job is declared. Owning services push a `JobDefinition` from
 * `onModuleInit` (a pure, pg-boss-free act, so it is order-independent); the Scheduler drains the
 * registry once at application bootstrap, binding each job and recording its outcome in
 * `SchedulerService.jobStatus`.
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
