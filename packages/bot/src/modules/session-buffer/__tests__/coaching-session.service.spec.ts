import { CoachingSessionService } from '../coaching-session.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    coachingSession: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

describe('CoachingSessionService', () => {
  let service: CoachingSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CoachingSessionService();
  });

  it('opens new session on first touch', async () => {
    (prisma.coachingSession.upsert as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      discordId: '123',
      lastActivity: new Date(),
      mined: false,
      doNotMine: false,
    });

    const session = await service.touch('123');
    expect(prisma.coachingSession.upsert).toHaveBeenCalledWith({
      where: { discordId: '123' },
      create: expect.objectContaining({ discordId: '123' }),
      update: expect.objectContaining({ lastActivity: expect.any(Date) }),
    });
    expect(session.discordId).toBe('123');
  });

  it('extends existing session on subsequent touch', async () => {
    (prisma.coachingSession.upsert as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      discordId: '123',
      lastActivity: new Date(),
      mined: true,
      doNotMine: false,
    });

    await service.touch('123');
    await service.touch('123');

    expect(prisma.coachingSession.upsert).toHaveBeenCalledTimes(2);
  });

  it('ends stale sessions', async () => {
    (prisma.coachingSession.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'sess-1',
        discordId: '123',
        lastActivity: new Date(Date.now() - 60 * 60 * 1000),
        mined: false,
        doNotMine: false,
      },
    ]);

    const stale = await service.endStale();
    expect(stale).toHaveLength(1);
    expect(stale[0].discordId).toBe('123');
  });

  it('marks session as mined', async () => {
    (prisma.coachingSession.update as jest.Mock).mockResolvedValue({});

    await service.markMined('sess-1');

    expect(prisma.coachingSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { mined: true },
    });
  });

  it('quarantines session via upsert (creates row if tripwire-first)', async () => {
    (prisma.coachingSession.upsert as jest.Mock).mockResolvedValue({});

    await service.quarantine('123');

    expect(prisma.coachingSession.upsert).toHaveBeenCalledWith({
      where: { discordId: '123' },
      create: expect.objectContaining({ discordId: '123', doNotMine: true }),
      update: { doNotMine: true },
    });
  });

  it('quarantine is resilient to db errors', async () => {
    (prisma.coachingSession.upsert as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(service.quarantine('999')).resolves.not.toThrow();
  });

  it('checks if session is quarantined', async () => {
    (prisma.coachingSession.findUnique as jest.Mock).mockResolvedValue({
      doNotMine: true,
    });

    const quarantined = await service.isQuarantined('123');
    expect(quarantined).toBe(true);
  });

  it('returns false for non-quarantined session', async () => {
    (prisma.coachingSession.findUnique as jest.Mock).mockResolvedValue({
      doNotMine: false,
    });

    const quarantined = await service.isQuarantined('123');
    expect(quarantined).toBe(false);
  });

  it('returns false for missing session', async () => {
    (prisma.coachingSession.findUnique as jest.Mock).mockResolvedValue(null);

    const quarantined = await service.isQuarantined('999');
    expect(quarantined).toBe(false);
  });
});
