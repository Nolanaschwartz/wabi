import { GET, POST } from '../[...path]/route';

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

const { validateRequest } = require('@/lib/session');

describe('admin strategies proxy', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_DISCORD_IDS = 'op_1';
    process.env.ADMIN_API_SECRET = 'sekret';
    process.env.BOT_API_URL = 'http://bot:3000';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.ADMIN_DISCORD_IDS;
    delete process.env.ADMIN_API_SECRET;
    delete process.env.BOT_API_URL;
  });

  it('returns 403 for a non-operator GET without calling the bot', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'someone_else' }, session: {} });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await GET({} as any, { params: Promise.resolve({ path: ['pending'] }) });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated request', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await POST({ json: async () => ({ id: '1' }) } as any, {
      params: Promise.resolve({ path: ['1', 'approve'] }),
    });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards an operator GET to the bot with the shared secret', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: '1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await GET({} as any, { params: Promise.resolve({ path: ['pending'] }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bot:3000/admin/strategies/pending',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
      }),
    );
  });

  it('forwards an operator POST body and path to the bot', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1', evidence: 'RCT' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await POST({ json: async () => ({ evidence: 'RCT' }) } as any, {
      params: Promise.resolve({ path: ['1', 'evidence'] }),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bot:3000/admin/strategies/1/evidence',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ evidence: 'RCT' }),
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
      }),
    );
  });
});
