import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

/**
 * Owns the worker's single pg-boss lifecycle (ADR-0034). Feature modules that schedule jobs import
 * this; because Nest initialises an imported module before its importer, the shared client is
 * started here BEFORE ResearchScheduleService's boot re-assert runs — so the schedule survives
 * restarts. Mirrors the bot's SchedulerModule.
 */
@Module({
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly scheduler: SchedulerService) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.scheduler.stop();
  }
}
