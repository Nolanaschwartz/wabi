import { Module } from '@nestjs/common';
import { ResearchConfigService } from './config-service/research-config.service';
import { ResearchAdminController } from './admin/research-admin.controller';
import { AdminGuard } from './admin/admin.guard';

/**
 * The research worker's feature module (ADR-0034). Owns config persistence, the admin HTTP surface,
 * and the admin guard. Later slices add the scheduler, schedule service, and runner here.
 */
@Module({
  controllers: [ResearchAdminController],
  providers: [ResearchConfigService, AdminGuard],
  exports: [ResearchConfigService],
})
export class ResearchModule {}
