import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { StrategyAdminService } from './strategy-admin.service';

@Controller('admin/strategies')
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
}
