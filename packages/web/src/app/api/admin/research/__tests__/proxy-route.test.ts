import { GET, POST, PATCH, PUT, DELETE } from '../[...path]/route';

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

  it('returns 403 for a non-operator PATCH without calling the worker', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'someone_else' }, session: {} });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await PATCH({ json: async () => ({ enabled: false }) } as any, {
      params: Promise.resolve({ path: ['topics', 't1'] }),
    });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-operator DELETE without calling the worker', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'someone_else' }, session: {} });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await DELETE({} as any, {
      params: Promise.resolve({ path: ['topics', 't1'] }),
    });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards an operator PATCH to the worker with the shared secret and body', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 't1', enabled: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await PATCH({ json: async () => ({ enabled: false }) } as any, {
      params: Promise.resolve({ path: ['topics', 't1'] }),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://research:3002/admin/research/topics/t1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('returns 403 for a non-operator PUT without calling the worker', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'someone_else' }, session: {} });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await PUT({ json: async () => ({ tokenBudget: 1000 }) } as any, {
      params: Promise.resolve({ path: ['bounds'] }),
    });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards an operator PUT bounds to the worker with the shared secret and body', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const bounds = { tokenBudget: 1000, maxTopicsPerRun: 5 };
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'singleton', ...bounds }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await PUT({ json: async () => bounds } as any, {
      params: Promise.resolve({ path: ['bounds'] }),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://research:3002/admin/research/bounds',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
        body: JSON.stringify(bounds),
      }),
    );
  });

  it('forwards an operator DELETE to the worker with the shared secret', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'op_1' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 't1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await DELETE({} as any, {
      params: Promise.resolve({ path: ['topics', 't1'] }),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://research:3002/admin/research/topics/t1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'x-admin-secret': 'sekret' }),
      }),
    );
  });
});
