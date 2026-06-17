// pg-boss is ESM-only; mock it so importing SchedulerService (transitively, for DI typing) does not
// load the real module under jest's CommonJS runtime. This service never touches pg-boss directly.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

import { BadRequestException } from '@nestjs/common';
import { ResearchScheduleService } from '../research-schedule.service';
import type { SchedulerService } from '../../scheduler/scheduler.service';
import type { ResearchConfigService } from '../../config-service/research-config.service';

const RESEARCH_RUN = 'research-run';

function makeScheduler() {
  return {
    schedule: jest.fn().mockResolvedValue(undefined),
    unschedule: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<SchedulerService, 'schedule' | 'unschedule'>> &
    SchedulerService;
}

describe('ResearchScheduleService', () => {
  const ORIGINAL_TZ = process.env.RESEARCH_TZ;

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.RESEARCH_TZ;
    else process.env.RESEARCH_TZ = ORIGINAL_TZ;
  });

  describe('apply', () => {
    it('schedules research-run when enabled with a valid cron, passing tz from RESEARCH_TZ', async () => {
      delete process.env.RESEARCH_TZ; // default UTC
      const scheduler = makeScheduler();
      const config = { getConfig: jest.fn() } as unknown as ResearchConfigService;
      const svc = new ResearchScheduleService(scheduler, config);

      await svc.apply({ scheduleEnabled: true, scheduleCron: '0 3 * * *' });

      expect(scheduler.schedule).toHaveBeenCalledWith(RESEARCH_RUN, '0 3 * * *', {}, { tz: 'UTC' });
      expect(scheduler.unschedule).not.toHaveBeenCalled();
    });

    it('reads tz lazily from RESEARCH_TZ per call (never cached)', async () => {
      process.env.RESEARCH_TZ = 'America/New_York';
      const scheduler = makeScheduler();
      const svc = new ResearchScheduleService(
        scheduler,
        { getConfig: jest.fn() } as unknown as ResearchConfigService,
      );

      await svc.apply({ scheduleEnabled: true, scheduleCron: '30 2 * * *' });

      expect(scheduler.schedule).toHaveBeenCalledWith(RESEARCH_RUN, '30 2 * * *', {}, {
        tz: 'America/New_York',
      });
    });

    it('unschedules when disabled', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchScheduleService(
        scheduler,
        { getConfig: jest.fn() } as unknown as ResearchConfigService,
      );

      await svc.apply({ scheduleEnabled: false, scheduleCron: '0 3 * * *' });

      expect(scheduler.unschedule).toHaveBeenCalledWith(RESEARCH_RUN);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('unschedules when cron is empty/null even if enabled', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchScheduleService(
        scheduler,
        { getConfig: jest.fn() } as unknown as ResearchConfigService,
      );

      await svc.apply({ scheduleEnabled: true, scheduleCron: null });
      expect(scheduler.unschedule).toHaveBeenCalledWith(RESEARCH_RUN);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('rejects a malformed cron and never touches pg-boss', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchScheduleService(
        scheduler,
        { getConfig: jest.fn() } as unknown as ResearchConfigService,
      );

      await expect(
        svc.apply({ scheduleEnabled: true, scheduleCron: 'not a cron' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(scheduler.unschedule).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit — boot re-assert', () => {
    it('reads the persisted singleton and re-asserts the schedule', async () => {
      const scheduler = makeScheduler();
      const persisted = { id: 'singleton', scheduleEnabled: true, scheduleCron: '0 6 * * 1' };
      const config = {
        getConfig: jest.fn().mockResolvedValue({ config: persisted, topics: [] }),
      } as unknown as ResearchConfigService;
      const svc = new ResearchScheduleService(scheduler, config);

      await svc.onModuleInit();

      expect(config.getConfig).toHaveBeenCalledTimes(1);
      expect(scheduler.schedule).toHaveBeenCalledWith(RESEARCH_RUN, '0 6 * * 1', {}, { tz: 'UTC' });
    });

    it('boot is fail-safe: a missing/unreadable config does not throw', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const config = {
        getConfig: jest.fn().mockRejectedValue(new Error('db down')),
      } as unknown as ResearchConfigService;
      const svc = new ResearchScheduleService(scheduler, config);

      await expect(svc.onModuleInit()).resolves.toBeUndefined();
      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(scheduler.unschedule).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('boot with no persisted config row does nothing', async () => {
      const scheduler = makeScheduler();
      const config = {
        getConfig: jest.fn().mockResolvedValue({ config: null, topics: [] }),
      } as unknown as ResearchConfigService;
      const svc = new ResearchScheduleService(scheduler, config);

      await svc.onModuleInit();
      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(scheduler.unschedule).not.toHaveBeenCalled();
    });
  });
});
