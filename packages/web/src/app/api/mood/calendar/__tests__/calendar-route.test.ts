import { GET } from '../route';

// The route is now a thin adapter: authenticate → validate year/month → delegate to
// the mood-read module. Timezone/window/bucketing behaviour is tested at the module
// (mood-read.test.ts), so here we only assert the adapter's own job.
jest.mock('@/lib/session', () => ({ validateRequest: jest.fn() }));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('@/lib/mood-read', () => ({ monthGrid: jest.fn() }));

const { validateRequest } = require('@/lib/session');
const { monthGrid } = require('@/lib/mood-read');

const req = (query: string) => new Request(`http://localhost/api/mood/calendar${query}`);

const signedIn = () =>
  validateRequest.mockResolvedValue({
    user: { id: 'u1', discordId: 'disc_me', timezone: 'America/Los_Angeles' },
    session: {},
  });

describe('mood calendar route (thin adapter)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    monthGrid.mockResolvedValue([]);
  });

  it('returns 401 for an unauthenticated request without delegating', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });

    const res = await GET(req('?year=2026&month=5'));

    expect(res.status).toBe(401);
    expect(monthGrid).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range or missing month with 400 and does not delegate', async () => {
    signedIn();

    expect((await GET(req('?year=2026&month=13'))).status).toBe(400);
    expect((await GET(req('?year=2026'))).status).toBe(400);
    expect((await GET(req('?year=abc&month=5'))).status).toBe(400);
    expect(monthGrid).not.toHaveBeenCalled();
  });

  it('delegates to monthGrid with the caller account and returns its grid', async () => {
    signedIn();
    monthGrid.mockResolvedValue([{ date: '2026-05-01', avg: 3 }]);

    const res = await GET(req('?year=2026&month=5'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(monthGrid).toHaveBeenCalledWith(
      expect.anything(),
      { discordId: 'disc_me', timezone: 'America/Los_Angeles' },
      2026,
      5,
    );
    expect(body.days).toEqual([{ date: '2026-05-01', avg: 3 }]);
  });
});
