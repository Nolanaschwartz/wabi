// pg-boss is ESM-only; mock it so importing the controller (which transitively pulls in the
// scheduler for DI) does not load the real module under jest's CommonJS runtime.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { ResearchAdminController } from '../research-admin.controller';
import { ResearchConfigService } from '../../config-service/research-config.service';
import type { ResearchScheduleService } from '../../schedule-service/research-schedule.service';

function makeSchedule() {
  return { apply: jest.fn().mockResolvedValue(undefined) } as unknown as ResearchScheduleService;
}

describe('ResearchAdminController', () => {
  it('GET config delegates to ResearchConfigService.getConfig', async () => {
    const payload = { config: { id: 'singleton' }, topics: [{ id: 't1' }] };
    const service = { getConfig: jest.fn().mockResolvedValue(payload) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.getConfig()).resolves.toEqual(payload);
    expect(service.getConfig).toHaveBeenCalledTimes(1);
  });

  it('POST topics delegates to createTopic', async () => {
    const created = { id: 't9', text: 'sleep', enabled: true };
    const service = { createTopic: jest.fn().mockResolvedValue(created) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.createTopic({ text: 'sleep' })).resolves.toEqual(created);
    expect(service.createTopic).toHaveBeenCalledWith('sleep');
  });

  it('POST topics surfaces a ConflictException for duplicate text (→ 409)', async () => {
    const service = {
      createTopic: jest.fn().mockRejectedValue(new ConflictException({ status: 'duplicate' })),
    } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.createTopic({ text: 'dup' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('PATCH topics/:id delegates to updateTopic', async () => {
    const updated = { id: 't1', text: 'a', enabled: false };
    const service = { updateTopic: jest.fn().mockResolvedValue(updated) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.updateTopic('t1', { enabled: false })).resolves.toEqual(updated);
    expect(service.updateTopic).toHaveBeenCalledWith('t1', { enabled: false });
  });

  it('PUT bounds delegates to updateBounds and returns the updated config', async () => {
    const bounds = {
      maxTopicsPerRun: 5,
      maxPapersPerTopic: 8,
      maxDiscoverySteps: 2,
      maxDraftsPerTopic: 3,
      maxDraftsPerRun: 10,
      agentTimeoutMs: 90000,
      runTimeoutMs: 600000,
      tokenBudget: 200000,
    };
    const updated = { id: 'singleton', ...bounds };
    const service = { updateBounds: jest.fn().mockResolvedValue(updated) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.updateBounds(bounds)).resolves.toEqual(updated);
    expect(service.updateBounds).toHaveBeenCalledWith(bounds);
  });

  it('PUT bounds surfaces a BadRequestException for an invalid payload (→ 400)', async () => {
    const service = {
      updateBounds: jest.fn().mockRejectedValue(new BadRequestException('tokenBudget out of range')),
    } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.updateBounds({ tokenBudget: 0 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('DELETE topics/:id delegates to deleteTopic', async () => {
    const service = {
      deleteTopic: jest.fn().mockResolvedValue({ id: 't1', text: 'a', enabled: true }),
    } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service, makeSchedule());

    await expect(controller.deleteTopic('t1')).resolves.toEqual({ id: 't1', text: 'a', enabled: true });
    expect(service.deleteTopic).toHaveBeenCalledWith('t1');
  });

  describe('PUT schedule', () => {
    it('persists then applies for a valid cron, returning the updated config', async () => {
      const updated = { id: 'singleton', scheduleCron: '0 3 * * *', scheduleEnabled: true };
      const service = {
        updateSchedule: jest.fn().mockResolvedValue(updated),
      } as unknown as ResearchConfigService;
      const schedule = makeSchedule();
      const controller = new ResearchAdminController(service, schedule);

      await expect(
        controller.updateSchedule({ cron: '0 3 * * *', enabled: true }),
      ).resolves.toEqual(updated);

      expect(service.updateSchedule).toHaveBeenCalledWith('0 3 * * *', true);
      expect(schedule.apply).toHaveBeenCalledWith({
        scheduleCron: '0 3 * * *',
        scheduleEnabled: true,
      });
    });

    it('persists a null cron (unscheduled) and applies', async () => {
      const updated = { id: 'singleton', scheduleCron: null, scheduleEnabled: false };
      const service = {
        updateSchedule: jest.fn().mockResolvedValue(updated),
      } as unknown as ResearchConfigService;
      const schedule = makeSchedule();
      const controller = new ResearchAdminController(service, schedule);

      await controller.updateSchedule({ cron: null, enabled: false });

      expect(service.updateSchedule).toHaveBeenCalledWith(null, false);
      expect(schedule.apply).toHaveBeenCalledWith({ scheduleCron: null, scheduleEnabled: false });
    });

    it('rejects a malformed cron with 400 and NEVER persists or writes pg-boss', async () => {
      const service = {
        updateSchedule: jest.fn(),
      } as unknown as ResearchConfigService;
      const schedule = makeSchedule();
      const controller = new ResearchAdminController(service, schedule);

      await expect(
        controller.updateSchedule({ cron: 'not a cron', enabled: true }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(service.updateSchedule).not.toHaveBeenCalled();
      expect(schedule.apply).not.toHaveBeenCalled();
    });
  });
});
