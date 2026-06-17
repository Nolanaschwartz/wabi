import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { ResearchConfigService } from '../config-service/research-config.service';

/**
 * Admin HTTP surface for the research worker (ADR-0034). All routes are behind the timing-safe
 * `x-admin-secret` guard; the web proxy is the only caller. Slice 01 exposes the read-only config;
 * mutation endpoints (schedule/bounds/topics/run/runs) arrive in later slices.
 */
@Controller('admin/research')
@UseGuards(AdminGuard)
export class ResearchAdminController {
  constructor(private readonly config: ResearchConfigService) {}

  @Get('config')
  async getConfig() {
    return this.config.getConfig();
  }
}
