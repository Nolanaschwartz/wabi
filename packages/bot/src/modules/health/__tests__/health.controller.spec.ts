// SchedulerService (the DI token below) imports pg-boss, an ESM-only package jest can't parse; mock
// it so the transitive import resolves. The service itself is supplied as a useValue stub.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { HealthController, HealthService } from '../health.controller';
import { Client } from 'discord.js';
import * as shared from '@wabi/shared';
import { SchedulerService } from '../../scheduler/scheduler.service';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  const mockClient = {
    isReady: jest.fn(),
  };

  const mockPrisma = {
    $queryRaw: jest.fn(),
  };

  const mockScheduler = {
    jobStatus: { registered: [], degraded: [], failed: [] } as Record<string, string[]>,
  };

  beforeEach(async () => {
    jest.spyOn(shared, 'prisma', 'get').mockReturnValue(mockPrisma as any);
    mockScheduler.jobStatus = { registered: [], degraded: [], failed: [] };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: Client,
          useValue: mockClient,
        },
        {
          provide: SchedulerService,
          useValue: mockScheduler,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    service = module.get<HealthService>(HealthService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns ok when gateway and db are healthy', async () => {
    mockClient.isReady.mockReturnValue(true);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const result = await controller.check();
    expect(result).toEqual({
      status: 'ok',
      checks: { gateway: true, db: true },
      jobs: { registered: [], degraded: [], failed: [] },
    });
  });

  it('surfaces job registration outcomes without flipping status to degraded', async () => {
    mockClient.isReady.mockReturnValue(true);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockScheduler.jobStatus = {
      registered: ['session-sweeper', 'strategy-demote'],
      degraded: [],
      failed: ['tilt-auto-resolve'],
    };

    const result = await controller.check();
    // A failed job is surfaced for an operator, but gateway+db are up, so the bot is still serving
    // DMs — health stays ok rather than 503-ing the process into a restart that wouldn't fix it.
    expect(result.status).toBe('ok');
    expect(result.jobs).toEqual({
      registered: ['session-sweeper', 'strategy-demote'],
      degraded: [],
      failed: ['tilt-auto-resolve'],
    });
  });

  it('returns 503 when db is down', async () => {
    mockClient.isReady.mockReturnValue(true);
    mockPrisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    await expect(controller.check()).rejects.toThrow();
  });

  it('returns 503 when gateway is not ready', async () => {
    mockClient.isReady.mockReturnValue(false);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await expect(controller.check()).rejects.toThrow();
  });

  it('returns 503 when both are down', async () => {
    mockClient.isReady.mockReturnValue(false);
    mockPrisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    await expect(controller.check()).rejects.toThrow();
  });
});
