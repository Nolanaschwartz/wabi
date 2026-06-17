import { GET, POST } from '../[...path]/route';

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

const { validateRequest } = require('@/lib/session');

describe('admin research proxy', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_DISCORD_IDS = 'op_1';
    process.env.ADMIN_API_SECRET = 'sekret';
    process.env.RESEARCH_API_URL = 'http://research:3002';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.ADMIN_DISCORD_IDS;
    delete process.env.ADMIN_API_SECRET;
    delete process.env.RESEARCH_API_URL;
  });

  it('returns 403 for a non-operator GET without calling the worker', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'someone_else' }, session: {} });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await GET({} as any, { params: Promise.resolve({ path: ['config'] }) });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated request', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await POST({ json: async () => ({}) } as any, {
      params: Promise.resolve({ path: ['run'] }),
    });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards an operator GET to the worker with the shared secret', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ config: {}, topics: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await GET({} as any, { params: Promise.resolve({ path: ['config'] }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://research:3002/admin/research/config',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
      }),
    );
  });
});
