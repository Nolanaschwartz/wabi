import { Module } from '@nestjs/common';
import { ResearchConfigService } from './config-service/research-config.service';
import { ResearchAdminController } from './admin/research-admin.controller';
import { AdminGuard } from './admin/admin.guard';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ResearchScheduleService } from './schedule-service/research-schedule.service';

/**
 * The research worker's feature module (ADR-0034). Owns config persistence, the admin HTTP surface,
 * the admin guard, and (issue 04) the schedule reconciler. Imports SchedulerModule so its pg-boss
 * client is started BEFORE ResearchScheduleService's boot re-assert runs (Nest initialises imported
 * modules before their importer — the same ordering trick the bot uses). Later slices add the runner.
 */
@Module({
  imports: [SchedulerModule],
  controllers: [ResearchAdminController],
  providers: [ResearchConfigService, AdminGuard, ResearchScheduleService],
  exports: [ResearchConfigService, ResearchScheduleService],
})
export class ResearchModule {}
