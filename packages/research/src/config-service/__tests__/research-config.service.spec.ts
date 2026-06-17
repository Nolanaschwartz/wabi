import { SEED_TOPICS } from '../../seed-topics';

// Mock the shared prisma singleton — the service uses it directly (codebase pattern).
const prismaMock = {
  researchConfig: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
  },
  researchTopic: {
    count: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.mock('@wabi/shared', () => ({
  get prisma() {
    return prismaMock;
  },
}));

import { ResearchConfigService } from '../research-config.service';

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
});
