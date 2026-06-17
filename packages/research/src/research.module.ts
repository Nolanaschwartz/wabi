import { Module } from '@nestjs/common';
import { ResearchConfigService } from './config-service/research-config.service';
import { ResearchAdminController } from './admin/research-admin.controller';
import { AdminGuard } from './admin/admin.guard';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ResearchScheduleService } from './schedule-service/research-schedule.service';
import { ResearchRunService } from './run-service/research-run.service';
import { ResearchRunnerService } from './run-service/research-runner.service';
import { defaultLogger } from './util/logger';

/**
 * The research worker's feature module (ADR-0034). Owns config persistence, the admin HTTP surface,
 * the admin guard, the schedule reconciler (issue 04), and the research-run consumer + run history
 * (issue 05). Imports SchedulerModule so its pg-boss client is started BEFORE the boot hooks here run
 * (Nest initialises imported modules before their importer — the same ordering trick the bot uses).
 *
 * Provider order matters at boot: ResearchRunService is listed BEFORE ResearchScheduleService so the
 * singleton `research-run` queue is created (with its policy) by the consumer's onModuleInit before
 * the schedule reconciler asserts the cron schedule against it. Nest runs onModuleInit in provider
 * declaration order within a module. Later slices replace the heartbeat run body with the real run.
 */
@Module({
  imports: [SchedulerModule],
  controllers: [ResearchAdminController],
  providers: [
    ResearchConfigService,
    AdminGuard,
    // The runner takes an optional injectable-deps bag (a plain interface, no Nest token), so it is
    // constructed via a factory with production defaults rather than Nest's reflective resolution.
    // Wire the real stderr logger (gated by RESEARCH_LOG_LEVEL); WITHOUT this the runner falls back
    // to noopLogger and the entire DI-driven run path (manual "Run now" + scheduled) is silent.
    { provide: ResearchRunnerService, useFactory: () => new ResearchRunnerService({ log: defaultLogger() }) },
    ResearchRunService,
    ResearchScheduleService,
  ],
  exports: [ResearchConfigService, ResearchScheduleService, ResearchRunService],
})
export class ResearchModule {}
