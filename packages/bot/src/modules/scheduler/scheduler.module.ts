import {
  Module,
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { JobRegistry } from './job-registry';

/**
 * Owns the single pg-boss lifecycle and registers every declared job. The client starts in
 * `onModuleInit`; feature modules that import this then declare their jobs into the shared
 * `JobRegistry` from their own `onModuleInit`. The registry is drained in `onApplicationBootstrap`,
 * which Nest runs AFTER every module's `onModuleInit` — so registration no longer depends on module
 * init order, and every job binds in one pass with its outcome recorded on `SchedulerService.jobStatus`.
 */
@Module({
  providers: [SchedulerService, JobRegistry],
  exports: [SchedulerService, JobRegistry],
})
export class SchedulerModule implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly registry: JobRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.start();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.drainRegistry(this.registry);
  }

  async onModuleDestroy(): Promise<void> {
    await this.scheduler.stop();
  }
}
