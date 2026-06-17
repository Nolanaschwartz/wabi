import { POST as exportData } from '../export/route';
import { POST as deleteData } from '../delete-data/route';
import { POST as deleteAccount } from '../delete/route';

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  lucia: {
    sessionCookieName: 'auth_session',
    invalidateSession: jest.fn(),
    createBlankSessionCookie: jest.fn(() => ({ name: 'auth_session', value: '', attributes: {} })),
  },
}));

const { validateRequest } = require('@/lib/session');
const { lucia } = require('@/lib/auth');

/** A NextRequest-ish stub carrying the session cookie the delete route reads. */
function requestWithSession(sessionId: string | null) {
  return {
    cookies: { get: jest.fn().mockReturnValue(sessionId ? { value: sessionId } : undefined) },
  } as any;
}

describe('account export route', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATA_RIGHTS_API_SECRET = 'dr-sekret';
    process.env.BOT_API_URL = 'http://bot:3000';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.DATA_RIGHTS_API_SECRET;
    delete process.env.BOT_API_URL;
  });

  it('returns 401 for an unauthenticated request without calling the bot', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await exportData();

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the caller's own discordId and the shared secret, returning a JSON download", async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: '{"moods":[1,2]}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await exportData();

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bot:3000/internal/data-rights/export',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ discordId: 'disc_me' }),
        headers: expect.objectContaining({ 'x-data-rights-secret': 'dr-sekret' }),
      }),
    );
    // The person gets their data as a downloadable JSON attachment.
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('.json');
    expect(await res.text()).toBe('{"moods":[1,2]}');
  });

  it('relays a bot failure as a non-200 and does not fabricate a download', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    global.fetch = jest.fn().mockResolvedValue(
      new Response('boom', { status: 502 }),
    ) as any;

    const res = await exportData();

    expect(res.status).toBe(502);
    expect(res.headers.get('content-disposition')).toBeNull();
  });
});

describe('account delete-data route', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATA_RIGHTS_API_SECRET = 'dr-sekret';
    process.env.BOT_API_URL = 'http://bot:3000';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.DATA_RIGHTS_API_SECRET;
    delete process.env.BOT_API_URL;
  });

  it('returns 401 for an unauthenticated request without calling the bot', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await deleteData();

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the caller's own discordId and the shared secret, returning ok", async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await deleteData();

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bot:3000/internal/data-rights/delete-data',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ discordId: 'disc_me' }),
        headers: expect.objectContaining({ 'x-data-rights-secret': 'dr-sekret' }),
      }),
    );
  });

  it('relays a bot failure status so the UI can report an incomplete deletion', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    global.fetch = jest.fn().mockResolvedValue(new Response('boom', { status: 500 })) as any;

    const res = await deleteData();

    expect(res.status).toBe(500);
  });
});

describe('account delete (whole account) route', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATA_RIGHTS_API_SECRET = 'dr-sekret';
    process.env.BOT_API_URL = 'http://bot:3000';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.DATA_RIGHTS_API_SECRET;
    delete process.env.BOT_API_URL;
  });

  it('returns 401 for an unauthenticated request without calling the bot', async () => {
    validateRequest.mockResolvedValue({ user: null, session: null });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const res = await deleteAccount(requestWithSession('sess_1'));

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deletes the account, then invalidates the session and clears the cookie', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    const fetchSpy = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy as any;

    const res = await deleteAccount(requestWithSession('sess_1'));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bot:3000/internal/data-rights/delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ discordId: 'disc_me' }),
        headers: expect.objectContaining({ 'x-data-rights-secret': 'dr-sekret' }),
      }),
    );
    expect(lucia.invalidateSession).toHaveBeenCalledWith('sess_1');
    expect(res.cookies.get('auth_session')?.value).toBe('');
  });

  it('does NOT invalidate the session or clear the cookie when the bot fails', async () => {
    validateRequest.mockResolvedValue({ user: { discordId: 'disc_me' }, session: {} });
    global.fetch = jest.fn().mockResolvedValue(new Response('boom', { status: 500 })) as any;

    const res = await deleteAccount(requestWithSession('sess_1'));

    expect(res.status).toBe(500);
    expect(lucia.invalidateSession).not.toHaveBeenCalled();
  });
});
