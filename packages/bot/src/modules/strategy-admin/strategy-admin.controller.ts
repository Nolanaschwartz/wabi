import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { StrategyAdminService, IngestCandidate } from './strategy-admin.service';
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

  @Post(':id/remove')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string) {
    return this.admin.removePublished(id);
  }

  @Post(':id/evidence')
  @HttpCode(HttpStatus.OK)
  async setEvidence(@Param('id') id: string, @Body('evidence') evidence: string) {
    return this.admin.setEvidenceLevel(id, evidence);
  }

  @Post('ingest/batch')
  @HttpCode(HttpStatus.CREATED)
  async ingestBatch(@Body() body: { candidates: IngestCandidate[] }) {
    // A batch from one paper may carry mixed per-draft outcomes, so there is no single 409 to throw.
    // The worker reads the per-draft results array instead.
    return this.admin.ingestBatch(body.candidates ?? []);
  }

  @Get('seen')
  async seen(@Query('sourceId') sourceId: string) {
    return { seen: await this.admin.hasSeen(sourceId) };
  }
}
