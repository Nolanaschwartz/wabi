import { POST as acceptPost } from '../accept/route';
import { POST as declinePost } from '../decline/route';
import {
  createPendingConsentToken,
  PENDING_CONSENT_COOKIE,
} from '@/lib/pending-consent';

jest.mock('@/lib/auth', () => ({
  lucia: {
    createSession: jest.fn(async () => ({ id: 'sess1' })),
    createSessionCookie: jest.fn(() => ({ name: 'session', value: 'sval', attributes: { path: '/' } })),
  },
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      upsert: jest.fn(),
    },
  },
}));

const { lucia } = require('@/lib/auth');
const { prisma } = require('@wabi/shared');

function reqWith(cookieValue?: string): any {
  return {
    cookies: {
      get: (name: string) =>
        name === PENDING_CONSENT_COOKIE && cookieValue ? { value: cookieValue } : undefined,
    },
  };
}

describe('Consent routes (deferred user creation — issue #29)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    process.env.TRIAL_DAYS = '7';
    process.env.LUCIA_SECRET = 'test-secret-for-signing';
  });

  describe('accept', () => {
    it('returns 401 and persists nothing without a pending-consent cookie', async () => {
      const res = await acceptPost(reqWith(undefined));
      expect(res.status).toBe(401);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(lucia.createSession).not.toHaveBeenCalled();
    });

    it('returns 401 and persists nothing for a tampered token', async () => {
      const res = await acceptPost(reqWith('forged-payload.forged-signature'));
      expect(res.status).toBe(401);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });

    it('creates the User + Trial and a session only on valid affirmative consent', async () => {
      prisma.user.upsert.mockResolvedValue({ id: 'u1' });
      const token = createPendingConsentToken('discord-123', 'gamer@example.com', Date.now());

      const res = await acceptPost(reqWith(token));

      expect(res.status).toBe(200);
      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { discordId: 'discord-123' },
          create: expect.objectContaining({
            discordId: 'discord-123',
            email: 'gamer@example.com',
            consentAcceptedAt: expect.any(Date),
            trialEndsAt: expect.any(Date),
            subscriptionStatus: 'trialing',
          }),
        }),
      );
      expect(lucia.createSession).toHaveBeenCalledWith('u1', {});

      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('session=');
      // The pending cookie is consumed (cleared) once the real session exists.
      expect(setCookie).toContain(`${PENDING_CONSENT_COOKIE}=;`);
    });
  });

  describe('decline', () => {
    it('persists nothing and clears the pending cookie (no decline-time delete)', async () => {
      const res = await declinePost();

      expect(res.status).toBe(200);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(`${PENDING_CONSENT_COOKIE}=;`);
    });
  });
});
