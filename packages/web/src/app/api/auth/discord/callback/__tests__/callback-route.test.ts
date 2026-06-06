import { GET } from '../route';
import { PENDING_CONSENT_COOKIE } from '@/lib/pending-consent';

jest.mock('@/lib/auth', () => ({
  discordAuth: {
    validateAuthorizationCode: jest.fn(async () => ({ accessToken: 'access-token' })),
  },
  lucia: {
    createSession: jest.fn(async () => ({ id: 'sess1' })),
    createSessionCookie: jest.fn(() => ({ name: 'session', value: 'sval', attributes: { path: '/' } })),
  },
}));

jest.mock('arctic', () => ({
  OAuth2RequestError: class OAuth2RequestError extends Error {},
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

const { lucia } = require('@/lib/auth');
const { prisma } = require('@wabi/shared');

function callbackRequest(): any {
  return {
    url: 'https://wabi.gg/api/auth/discord/callback?code=abc&state=xyz',
    cookies: {
      get: (name: string) =>
        name === 'discord_oauth_state' ? { value: 'xyz' } : undefined,
    },
  };
}

describe('Discord OAuth callback (deferred user creation — issue #29)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    process.env.LUCIA_SECRET = 'test-secret-for-signing';
    global.fetch = jest.fn(async () => ({
      json: async () => ({ id: 'discord-new', email: 'new@example.com' }),
    })) as any;
  });

  it('does NOT create a User or session for a new identity; sets a pending-consent cookie', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await GET(callbackRequest());

    // The core GDPR requirement: nothing persisted before consent.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(lucia.createSession).not.toHaveBeenCalled();

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/consent');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PENDING_CONSENT_COOKIE}=`);
    // No real session cookie yet.
    expect(setCookie).not.toContain('session=sval');
  });

  it('signs the user straight in (no consent gate) for an already-consented returning User', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', discordId: 'discord-new' });

    const res = await GET(callbackRequest());

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(lucia.createSession).toHaveBeenCalledWith('u1', {});
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard');
  });
});
