import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DataRightsApiGuard } from './data-rights-api.guard';

interface DataRightsRequest {
  /**
   * The person's Discord id. In this schema the child-record `userId` column actually holds the
   * discordId, so export/delete are keyed by it (the same value the Discord `/data` command passes).
   * The web proxy forwards the signed-in lucia user's own `discordId`.
   */
  discordId: string;
}

/**
 * Internal HTTP surface for data rights, invoked only by the web `/api/account/*` routes carrying
 * the shared `DataRightsApiGuard` secret. Not a Discord controller and never browser-reachable.
 * Mirrors the strategy-admin controller/guard pattern.
 */
@Controller('internal/data-rights')
@UseGuards(DataRightsApiGuard)
export class DataRightsApiController {
  constructor(private readonly dataRights: DataRightsService) {}

  @Post('export')
  async export(@Body() { discordId }: DataRightsRequest): Promise<{ data: string }> {
    return { data: await this.dataRights.export(discordId) };
  }

  /**
   * Delete the person's child data but keep their account (and subscription). Mirrors the Discord
   * `/data delete`. A failure propagates (→ 500) so the web learns the deletion was incomplete
   * rather than falsely reporting success — Data Rights are unconditional (ADR-0011).
   */
  @Post('delete-data')
  async deleteData(@Body() { discordId }: DataRightsRequest): Promise<{ ok: true }> {
    await this.dataRights.delete(discordId);
    return { ok: true };
  }
}
