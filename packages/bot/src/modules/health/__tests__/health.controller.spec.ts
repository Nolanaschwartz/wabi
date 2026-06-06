import { Test, TestingModule } from '@nestjs/testing';
import { HealthController, HealthService } from '../health.controller';
import { Client } from 'discord.js';
import * as shared from '@wabi/shared';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  const mockClient = {
    isReady: jest.fn(),
  };

  const mockPrisma = {
    $queryRaw: jest.fn(),
  };

  beforeEach(async () => {
    jest.spyOn(shared, 'prisma', 'get').mockReturnValue(mockPrisma as any);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: Client,
          useValue: mockClient,
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
