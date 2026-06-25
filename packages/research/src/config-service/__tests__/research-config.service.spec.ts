import { SEED_TOPICS } from '../../seed-topics';

// Mock the shared prisma singleton — the service uses it directly (codebase pattern).
const prismaMock = {
  researchConfig: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  researchTopic: {
    count: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

jest.mock('@wabi/shared', () => ({
  get prisma() {
    return prismaMock;
  },
}));

import { ResearchConfigService } from '../research-config.service';
import { DEFAULTS } from '../../run-bounds';

describe('ResearchConfigService', () => {
  let service: ResearchConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ResearchConfigService();
  });

  describe('seedOnBoot', () => {
    it('upserts the singleton config with create-only defaults (never clobbers an existing row)', async () => {
      prismaMock.researchConfig.upsert.mockResolvedValue({ id: 'singleton' });
      prismaMock.researchTopic.count.mockResolvedValue(0);
      prismaMock.researchTopic.createMany.mockResolvedValue({ count: SEED_TOPICS.length });

      await service.seedOnBoot();

      expect(prismaMock.researchConfig.upsert).toHaveBeenCalledTimes(1);
      const arg = prismaMock.researchConfig.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'singleton' });
      // update must be a no-op so a repeat boot never resets operator edits.
      expect(arg.update).toEqual({});
      expect(arg.create).toEqual({ id: 'singleton' });
    });

    it('seeds topics from SEED_TOPICS only when the topics table is empty', async () => {
      prismaMock.researchConfig.upsert.mockResolvedValue({ id: 'singleton' });
      prismaMock.researchTopic.count.mockResolvedValue(0);
      prismaMock.researchTopic.createMany.mockResolvedValue({ count: SEED_TOPICS.length });

      await service.seedOnBoot();

      expect(prismaMock.researchTopic.createMany).toHaveBeenCalledTimes(1);
      const arg = prismaMock.researchTopic.createMany.mock.calls[0][0];
      expect(arg.data).toEqual(SEED_TOPICS.map((text) => ({ text })));
      expect(arg.skipDuplicates).toBe(true);
    });

    it('does not seed topics when the table already has rows (idempotent restart)', async () => {
      prismaMock.researchConfig.upsert.mockResolvedValue({ id: 'singleton' });
      prismaMock.researchTopic.count.mockResolvedValue(SEED_TOPICS.length);

      await service.seedOnBoot();

      expect(prismaMock.researchTopic.createMany).not.toHaveBeenCalled();
    });
  });

  describe('getConfig', () => {
    it('returns the singleton config and the topic list', async () => {
      const config = { id: 'singleton', scheduleCron: null, scheduleEnabled: false, maxTopicsPerRun: 5 };
      const topics = [{ id: 't1', text: 'a', enabled: true }];
      prismaMock.researchConfig.findUnique.mockResolvedValue(config);
      prismaMock.researchTopic.findMany.mockResolvedValue(topics);

      const result = await service.getConfig();

      expect(prismaMock.researchConfig.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } });
      expect(result).toEqual({ config, topics });
    });
  });

  describe('getEnabledTopics', () => {
    it('returns only enabled topics, ordered by createdAt asc', async () => {
      const enabled = [{ id: 't1', text: 'a', enabled: true }];
      prismaMock.researchTopic.findMany.mockResolvedValue(enabled);

      const result = await service.getEnabledTopics();

      expect(prismaMock.researchTopic.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual(enabled);
    });
  });

  describe('createTopic', () => {
    it('persists a new topic', async () => {
      const created = { id: 't9', text: 'sleep hygiene', enabled: true };
      prismaMock.researchTopic.create.mockResolvedValue(created);

      const result = await service.createTopic('sleep hygiene');

      expect(prismaMock.researchTopic.create).toHaveBeenCalledWith({ data: { text: 'sleep hygiene' } });
      expect(result).toEqual(created);
    });

    it('rejects a duplicate text with a ConflictException (translates Prisma P2002)', async () => {
      const { ConflictException } = require('@nestjs/common');
      const p2002: any = new Error('Unique constraint failed');
      p2002.code = 'P2002';
      prismaMock.researchTopic.create.mockRejectedValue(p2002);

      await expect(service.createTopic('dup')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique-violation errors unchanged', async () => {
      const other: any = new Error('connection lost');
      prismaMock.researchTopic.create.mockRejectedValue(other);

      await expect(service.createTopic('x')).rejects.toBe(other);
    });
  });

  describe('updateTopic', () => {
    it('updates text and/or enabled state', async () => {
      const updated = { id: 't1', text: 'renamed', enabled: false };
      prismaMock.researchTopic.update.mockResolvedValue(updated);

      const result = await service.updateTopic('t1', { text: 'renamed', enabled: false });

      expect(prismaMock.researchTopic.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { text: 'renamed', enabled: false },
      });
      expect(result).toEqual(updated);
    });

    it('updates enabled alone without touching text', async () => {
      prismaMock.researchTopic.update.mockResolvedValue({ id: 't1', text: 'a', enabled: false });

      await service.updateTopic('t1', { enabled: false });

      expect(prismaMock.researchTopic.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { enabled: false },
      });
    });

    it('rejects an update that would duplicate another topic text (P2002 → Conflict)', async () => {
      const { ConflictException } = require('@nestjs/common');
      const p2002: any = new Error('Unique constraint failed');
      p2002.code = 'P2002';
      prismaMock.researchTopic.update.mockRejectedValue(p2002);

      await expect(service.updateTopic('t1', { text: 'dup' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateBounds', () => {
    const validBounds = {
      maxTopicsPerRun: 5,
      maxPapersPerTopic: 8,
      maxDiscoverySteps: 2,
      maxDraftsPerTopic: 3,
      maxDraftsPerRun: 10,
      agentTimeoutMs: 90000,
      runTimeoutMs: 600000,
      tokenBudget: 200000,
    };

    it('persists a fully-valid bounds payload to the singleton', async () => {
      const updated = { id: 'singleton', ...validBounds };
      prismaMock.researchConfig.update.mockResolvedValue(updated);

      const result = await service.updateBounds(validBounds);

      expect(prismaMock.researchConfig.update).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        data: validBounds,
      });
      expect(result).toEqual(updated);
    });

    it('rejects a zero tokenBudget (operator cannot silently save a budget that produces nothing)', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(service.updateBounds({ ...validBounds, tokenBudget: 0 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('rejects a zero count field', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(
        service.updateBounds({ ...validBounds, maxTopicsPerRun: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('rejects a negative count field', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(
        service.updateBounds({ ...validBounds, maxDraftsPerRun: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('rejects an out-of-band timeout (below the floor)', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(
        service.updateBounds({ ...validBounds, agentTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('rejects an out-of-band timeout (above the ceiling)', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(
        service.updateBounds({ ...validBounds, runTimeoutMs: 999_999_999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('rejects a non-integer field', async () => {
      const { BadRequestException } = require('@nestjs/common');

      await expect(
        service.updateBounds({ ...validBounds, maxPapersPerTopic: 2.5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.researchConfig.update).not.toHaveBeenCalled();
    });

    it('names the offending field in the rejection message', async () => {
      await expect(service.updateBounds({ ...validBounds, tokenBudget: 0 })).rejects.toThrow(
        /tokenBudget/,
      );
    });
  });

  describe('loadRunBounds', () => {
    const KEY = 'RESEARCH_SEARCH_LIMIT';
    const savedSearchLimit = process.env[KEY];
    afterEach(() => {
      if (savedSearchLimit === undefined) delete process.env[KEY];
      else process.env[KEY] = savedSearchLimit;
    });

    it('reads the singleton once and maps it to a full Bounds (searchLimit from env)', async () => {
      delete process.env[KEY];
      const row = {
        maxTopicsPerRun: 7, maxPapersPerTopic: 9, maxDiscoverySteps: 3, maxDraftsPerTopic: 4,
        maxDraftsPerRun: 12, agentTimeoutMs: 80_000, runTimeoutMs: 500_000, tokenBudget: 150_000,
      };
      prismaMock.researchConfig.findUnique.mockResolvedValue(row);

      const bounds = await service.loadRunBounds();

      expect(prismaMock.researchConfig.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } });
      expect(bounds).toEqual({ ...row, searchLimit: DEFAULTS.searchLimit });
    });

    it('fails soft to defaults when the singleton read throws (never throws)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env[KEY];
      prismaMock.researchConfig.findUnique.mockRejectedValue(new Error('db down'));

      await expect(service.loadRunBounds()).resolves.toEqual(DEFAULTS);
      errSpy.mockRestore();
    });

    it('falls back to defaults when the singleton row is missing', async () => {
      delete process.env[KEY];
      prismaMock.researchConfig.findUnique.mockResolvedValue(null);

      await expect(service.loadRunBounds()).resolves.toEqual(DEFAULTS);
    });
  });

  describe('updateSchedule', () => {
    it('persists cron + enabled to the singleton', async () => {
      const updated = { id: 'singleton', scheduleCron: '0 3 * * *', scheduleEnabled: true };
      prismaMock.researchConfig.update.mockResolvedValue(updated);

      const result = await service.updateSchedule('0 3 * * *', true);

      expect(prismaMock.researchConfig.update).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        data: { scheduleCron: '0 3 * * *', scheduleEnabled: true },
      });
      expect(result).toEqual(updated);
    });

    it('persists a null cron (unscheduled) and disabled', async () => {
      const updated = { id: 'singleton', scheduleCron: null, scheduleEnabled: false };
      prismaMock.researchConfig.update.mockResolvedValue(updated);

      await service.updateSchedule(null, false);

      expect(prismaMock.researchConfig.update).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        data: { scheduleCron: null, scheduleEnabled: false },
      });
    });
  });

  describe('deleteTopic', () => {
    it('removes the topic', async () => {
      prismaMock.researchTopic.delete.mockResolvedValue({ id: 't1', text: 'a', enabled: true });

      const result = await service.deleteTopic('t1');

      expect(prismaMock.researchTopic.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
      expect(result).toEqual({ id: 't1', text: 'a', enabled: true });
    });
  });
});
