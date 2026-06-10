import { InnerStateMemoryService } from '../inner-state-memory.service';
import { prisma } from '@wabi/shared';
import { UserService } from '../../user/user.service';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

describe('InnerStateMemoryService', () => {
  let service: InnerStateMemoryService;
  let memoryStore: { deriveAndStore: jest.Mock };
  let userService: jest.Mocked<UserService>;

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore = { deriveAndStore: jest.fn().mockResolvedValue(undefined) };
    userService = new UserService() as any;
    service = new InnerStateMemoryService(memoryStore as any, userService);
  });

  it('derives when the person has consented (innerStateMemoryEnabled = true)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: true });

    await service.deriveIfConsented('123', 'Journal: I felt isolated since the move');

    expect(memoryStore.deriveAndStore).toHaveBeenCalledTimes(1);
    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith(
      '123',
      'Journal: I felt isolated since the move',
    );
  });

  it('is a silent no-op when the person has not consented (flag false)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: false });

    await service.deriveIfConsented('123', 'Journal: anything');

    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the person has no User record', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue(null);

    await service.deriveIfConsented('123', 'Journal: anything');

    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });

  it('fails soft — swallows a degraded Mem0 (deriveAndStore throws) without rethrowing', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: true });
    memoryStore.deriveAndStore.mockRejectedValue(new Error('mem0 down'));

    await expect(
      service.deriveIfConsented('123', 'Journal: anything'),
    ).resolves.toBeUndefined();
  });

  it('fails soft — swallows a degraded consent lookup (findByDiscordId throws) without rethrowing', async () => {
    (userService.findByDiscordId as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(
      service.deriveIfConsented('123', 'Journal: anything'),
    ).resolves.toBeUndefined();
    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });
});
