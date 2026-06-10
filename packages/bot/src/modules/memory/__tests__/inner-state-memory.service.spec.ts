import { InnerStateMemoryService } from '../inner-state-memory.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

describe('InnerStateMemoryService', () => {
  let service: InnerStateMemoryService;
  let memoryStore: { deriveAndStore: jest.Mock };
  const findUnique = prisma.user.findUnique as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore = { deriveAndStore: jest.fn().mockResolvedValue(undefined) };
    service = new InnerStateMemoryService(memoryStore as any);
  });

  it('derives when the person has consented (innerStateMemoryEnabled = true)', async () => {
    findUnique.mockResolvedValue({ innerStateMemoryEnabled: true });

    await service.deriveIfConsented('123', 'Journal: I felt isolated since the move');

    expect(memoryStore.deriveAndStore).toHaveBeenCalledTimes(1);
    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith(
      '123',
      'Journal: I felt isolated since the move',
    );
  });

  it('is a silent no-op when the person has not consented (flag false)', async () => {
    findUnique.mockResolvedValue({ innerStateMemoryEnabled: false });

    await service.deriveIfConsented('123', 'Journal: anything');

    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the person has no User record', async () => {
    findUnique.mockResolvedValue(null);

    await service.deriveIfConsented('123', 'Journal: anything');

    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });

  it('fails soft — swallows a degraded Mem0 (deriveAndStore throws) without rethrowing', async () => {
    findUnique.mockResolvedValue({ innerStateMemoryEnabled: true });
    memoryStore.deriveAndStore.mockRejectedValue(new Error('mem0 down'));

    await expect(
      service.deriveIfConsented('123', 'Journal: anything'),
    ).resolves.toBeUndefined();
  });

  it('fails soft — swallows a degraded consent lookup (findUnique throws) without rethrowing', async () => {
    findUnique.mockRejectedValue(new Error('db down'));

    await expect(
      service.deriveIfConsented('123', 'Journal: anything'),
    ).resolves.toBeUndefined();
    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });
});
