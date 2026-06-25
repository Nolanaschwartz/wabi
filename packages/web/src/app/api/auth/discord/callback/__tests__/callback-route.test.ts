import { GET } from '../route';
import { PENDING_CONSENT_COOKIE } from '@/lib/pending-consent';

// The route is now a thin OAuth-transport adapter: state check → code exchange + /@me
// fetch → resolveOrPend → cookie/redirect. The existing-vs-new decision and the
// no-write-before-consent invariant are tested at the module (onboarding.test.ts).
jest.mock('@/lib/auth', () => ({
  discordAuth: {
    validateAuthorizationCode: jest.fn(async () => ({ accessToken: () => 'access-token' })),
  },
}));
jest.mock('arctic', () => ({ OAuth2RequestError: class OAuth2RequestError extends Error {} }));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('@/lib/onboarding', () => ({ resolveOrPend: jest.fn() }));
jest.mock('@/lib/session', () => ({ establishSession: jest.fn() }));

const { resolveOrPend } = require('@/lib/onboarding');
const { establishSession } = require('@/lib/session');

function callbackRequest(): any {
  return {
    url: 'https://wabi.gg/api/auth/discord/callback?code=abc&state=xyz',
    cookies: {
      get: (name: string) => (name === 'discord_oauth_state' ? { value: 'xyz' } : undefined),
    },
  };
}

describe('Discord OAuth callback (thin adapter)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    global.fetch = jest.fn(async () => ({
      json: async () => ({ id: 'discord-new', email: 'new@example.com' }),
    })) as any;
  });

  it('400s on a mismatched state without onboarding', async () => {
    const bad: any = {
      url: 'https://wabi.gg/api/auth/discord/callback?code=abc&state=WRONG',
      cookies: { get: () => ({ value: 'xyz' }) },
    };
    const res = await GET(bad);
    expect(res.status).toBe(400);
    expect(resolveOrPend).not.toHaveBeenCalled();
  });

  it('redirects a new identity to /consent with a pending cookie and no session', async () => {
    resolveOrPend.mockResolvedValue({ kind: 'pending', token: 'ptoken' });

    const res = await GET(callbackRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/consent');
    expect(establishSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toContain(`${PENDING_CONSENT_COOKIE}=ptoken`);
  });

  it('signs an existing User straight in to /dashboard', async () => {
    resolveOrPend.mockResolvedValue({ kind: 'existing', userId: 'u1' });

    const res = await GET(callbackRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard');
    expect(establishSession).toHaveBeenCalledWith('u1', expect.anything());
  });
});
