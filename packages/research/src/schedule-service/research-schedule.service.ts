import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ResearchConfigService } from '../config-service/research-config.service';
import { isValidCron } from '../cron-compile/cron-compile';

/** The pg-boss queue this worker schedules and consumes. */
export const RESEARCH_RUN_QUEUE = 'research-run';

/** The slice of ResearchConfig that drives scheduling. */
export interface SchedulableConfig {
  scheduleEnabled: boolean;
  scheduleCron: string | null;
}

/**
 * Reconciles the persisted ResearchConfig to pg-boss (ADR-0034). `apply(config)` is the single
 * scheduling decision: when the schedule is enabled AND the cron is valid, assert the recurring
 * `research-run` entry; otherwise remove it. A malformed cron is rejected (BadRequestException)
 * BEFORE it reaches pg-boss — the validation gate, so an operator never persists a schedule that
 * silently never fires.
 *
 * On boot it re-asserts the persisted schedule so a deploy/crash never drops the operator's cadence.
 * Boot is fail-safe: research is non-critical, so a missing/unreadable config logs and continues.
 *
 * `tz` comes from RESEARCH_TZ (default UTC), read lazily per call — never cached in a field/const,
 * because ConfigModule populates process.env at bootstrap after import time.
 */
@Injectable()
export class ResearchScheduleService implements OnModuleInit {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly config: ResearchConfigService,
  ) {}

  /** Resolve the schedule timezone lazily (RESEARCH_TZ, default UTC). Never cache this. */
  private get tz(): string {
    return process.env.RESEARCH_TZ || 'UTC';
  }

  /**
   * Reconcile pg-boss with the given config. Schedules when enabled + valid cron; unschedules when
   * disabled or cron-empty. Throws BadRequestException on a malformed (non-empty) cron WITHOUT
   * touching pg-boss.
   */
  async apply(config: SchedulableConfig): Promise<void> {
    const cron = config.scheduleCron?.trim() ?? '';

    // A non-empty cron must be well-formed before anything reaches pg-boss.
    if (cron !== '' && !isValidCron(cron)) {
      throw new BadRequestException({
        status: 'invalid-cron',
        message: `Invalid cron expression: ${cron}`,
      });
    }

    if (config.scheduleEnabled && cron !== '') {
      await this.scheduler.schedule(RESEARCH_RUN_QUEUE, cron, {}, { tz: this.tz });
    } else {
      await this.scheduler.unschedule(RESEARCH_RUN_QUEUE);
    }
  }

  /**
   * Boot re-assert: read the persisted singleton and reconcile pg-boss so the schedule survives a
   * restart. Fail-safe — a DB outage or absent config row must not block worker startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { config } = await this.config.getConfig();
      if (!config) return;
      const c = config as SchedulableConfig;
      await this.apply({ scheduleEnabled: c.scheduleEnabled, scheduleCron: c.scheduleCron });
    } catch (err) {
      console.error('[research] boot schedule re-assert failed; continuing degraded', err);
    }
  }
}
