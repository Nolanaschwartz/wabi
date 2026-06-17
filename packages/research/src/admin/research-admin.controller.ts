import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import {
  ResearchBounds,
  ResearchConfigService,
} from '../config-service/research-config.service';
import { ResearchScheduleService } from '../schedule-service/research-schedule.service';
import { ResearchRunService } from '../run-service/research-run.service';
import { isValidCron } from '../cron-compile/cron-compile';

/**
 * Admin HTTP surface for the research worker (ADR-0034). All routes are behind the timing-safe
 * `x-admin-secret` guard; the web proxy is the only caller.
 */
@Controller('admin/research')
@UseGuards(AdminGuard)
export class ResearchAdminController {
  constructor(
    private readonly config: ResearchConfigService,
    private readonly schedule: ResearchScheduleService,
    private readonly runs: ResearchRunService,
  ) {}

  @Get('config')
  async getConfig() {
    return this.config.getConfig();
  }

  /**
   * Set the schedule (issue 04, ADR-0034). A malformed cron is rejected with 400 HERE, before
   * anything is persisted or written to pg-boss — so an operator never saves a schedule that
   * silently never fires. On a valid cron (or an empty/null cron meaning "unscheduled") we persist
   * `scheduleCron` + `scheduleEnabled`, then re-assert pg-boss via the schedule service. Returns the
   * updated config.
   */
  @Put('schedule')
  @HttpCode(HttpStatus.OK)
  async updateSchedule(@Body() body: { cron: string | null; enabled: boolean }) {
    const cron = body.cron && body.cron.trim() !== '' ? body.cron.trim() : null;
    if (cron !== null && !isValidCron(cron)) {
      throw new BadRequestException({
        status: 'invalid-cron',
        message: `Invalid cron expression: ${cron}`,
      });
    }
    const updated = await this.config.updateSchedule(cron, body.enabled);
    await this.schedule.apply({ scheduleCron: cron, scheduleEnabled: body.enabled });
    return updated;
  }

  /**
   * Tune the eight run bounds. The service range-validates server-side; an out-of-range value
   * (e.g. a zero token budget) surfaces a BadRequestException → 400. Returns the updated config.
   */
  @Put('bounds')
  @HttpCode(HttpStatus.OK)
  async updateBounds(@Body() body: ResearchBounds) {
    return this.config.updateBounds(body);
  }

  /** Add a seed topic. Duplicate `text` → 409 (service throws ConflictException). */
  @Post('topics')
  @HttpCode(HttpStatus.CREATED)
  async createTopic(@Body() body: { text: string }) {
    return this.config.createTopic(body.text);
  }

  /** Update a topic's text and/or enabled state. */
  @Patch('topics/:id')
  @HttpCode(HttpStatus.OK)
  async updateTopic(@Param('id') id: string, @Body() body: { text?: string; enabled?: boolean }) {
    return this.config.updateTopic(id, body);
  }

  /** Remove a topic. */
  @Delete('topics/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTopic(@Param('id') id: string) {
    return this.config.deleteTopic(id);
  }

  /**
   * Manual "Run now" (issue 05, ADR-0034). Enqueues a manual run and returns its id. Single-flight
   * is reconciled in the service: a manual run landing during an active run collapses to the existing
   * run's id (no second row, no second enqueue). Degraded (DB/pg-boss down) returns `{ runId: null }`
   * rather than a 500.
   */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  async runNow() {
    return this.runs.triggerManualRun();
  }

  /**
   * Recent run history (issue 05). `limit` defaults to 20 and is clamped to a sane max in the
   * service. Rows are newest-first. An absent/non-numeric limit passes `undefined` so the service
   * applies its default.
   */
  @Get('runs')
  async listRuns(@Query('limit') limit?: string) {
    const parsed = limit !== undefined ? Number(limit) : undefined;
    const safe = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
    return this.runs.listRuns(safe);
  }
}
