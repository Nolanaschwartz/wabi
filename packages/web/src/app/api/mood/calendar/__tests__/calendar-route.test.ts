import { GET } from '../route';

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    mood: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

const { validateRequest } = require('@/lib/session');
const { prisma } = require('@wabi/shared');

const req = (query: string) => new Request(`http://localhost/api/mood/calendar${query}`);

const signedIn = () =>
  validateRequest.mockResolvedValue({ user: { id: 'u1', discordId: 'disc_me' }, session: {} });

describe('mood calendar route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ timezone: 'UTC' });
    prisma.mood.findMany.mockResolvedValue([]);
  });

  it('returns 401 for an unauthenticated request without touching the DB', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });

    const res = await GET(req('?year=2026&month=5'));

    expect(res.status).toBe(401);
    expect(prisma.mood.findMany).not.toHaveBeenCalled();
  });

  it('returns one day per day of the requested month with daily averages', async () => {
    signedIn();
    prisma.mood.findMany.mockResolvedValue([
      { rating: 2, createdAt: new Date('2026-05-10T08:00:00Z') },
      { rating: 4, createdAt: new Date('2026-05-10T20:00:00Z') },
    ]);

    const res = await GET(req('?year=2026&month=5'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.days).toHaveLength(31); // May
    const map = Object.fromEntries(body.days.map((d: any) => [d.date, d.avg]));
    expect(map['2026-05-10']).toBe(3); // (2 + 4) / 2
    expect(map['2026-05-11']).toBeNull();
  });

  it('buckets entries in the user stored timezone', async () => {
    signedIn();
    prisma.user.findUnique.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    // 2026-05-01T05:00:00Z is 2026-04-30 (22:00) in LA — outside May there.
    prisma.mood.findMany.mockResolvedValue([
      { rating: 5, createdAt: new Date('2026-05-01T05:00:00Z') },
    ]);

    const res = await GET(req('?year=2026&month=5'));
    const body = await res.json();

    expect(body.days.every((d: any) => d.avg === null)).toBe(true);
  });

  it('returns an all-null month when there are no logs', async () => {
    signedIn();
    prisma.mood.findMany.mockResolvedValue([]);

    const res = await GET(req('?year=2026&month=2'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.days).toHaveLength(28);
    expect(body.days.every((d: any) => d.avg === null)).toBe(true);
  });

  it('rejects an out-of-range or missing month with 400', async () => {
    signedIn();

    expect((await GET(req('?year=2026&month=13'))).status).toBe(400);
    expect((await GET(req('?year=2026'))).status).toBe(400);
    expect((await GET(req('?year=abc&month=5'))).status).toBe(400);
  });

  it('queries moods for the caller by their own discordId', async () => {
    signedIn();

    await GET(req('?year=2026&month=5'));

    expect(prisma.mood.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'disc_me' }),
      }),
    );
  });
});
