import { Controller, Get, Post, Body, Param, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { StrategyAdminService } from './strategy-admin.service';
import { AdminGuard } from './admin.guard';

@Controller('admin/strategies')
@UseGuards(AdminGuard)
export class StrategyAdminController {
  constructor(private readonly admin: StrategyAdminService) {}

  @Get('pending')
  async getPending() {
    return this.admin.getPendingDrafts();
  }

  @Get('published')
  async getPublished() {
    return this.admin.getPublishedDrafts();
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Body('id') id: string) {
    return this.admin.approveDraft(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(@Body('id') id: string) {
    return this.admin.rejectDraft(id);
  }

  @Post(':id/evidence')
  @HttpCode(HttpStatus.OK)
  async setEvidence(@Param('id') id: string, @Body('evidence') evidence: string) {
    return this.admin.setEvidenceLevel(id, evidence);
  }
}
