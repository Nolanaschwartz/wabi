import { POST as acceptPost } from '../accept/route';
import { POST as declinePost } from '../decline/route';

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  lucia: {
    invalidateSession: jest.fn(),
    createBlankSessionCookie: jest.fn(() => ({ name: 'session', value: '' })),
    sessionCookieName: 'session',
  },
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

const { validateRequest } = require('@/lib/session');
const { lucia } = require('@/lib/auth');
const { prisma } = require('@wabi/shared');

describe('Consent routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    process.env.TRIAL_DAYS = '7';
  });

  describe('accept', () => {
    it('returns 401 when not authenticated', async () => {
      validateRequest.mockResolvedValue({ user: null, session: null });
      expect(await (await acceptPost()).status).toBe(401);
    });

    it('sets consentAcceptedAt, trialEndsAt, and subscriptionStatus', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.update.mockResolvedValue({});

      const res = await acceptPost();
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/dashboard');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consentAcceptedAt: expect.any(Date),
            subscriptionStatus: 'trialing',
          }),
        }),
      );
    });
  });

  describe('decline', () => {
    it('returns 401 when not authenticated', async () => {
      validateRequest.mockResolvedValue({ user: null, session: null });
      expect(await (await declinePost()).status).toBe(401);
    });

    it('invalidates session, deletes user, clears cookie', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } });
      prisma.user.delete.mockResolvedValue({});

      const res = await declinePost();
      expect(res.status).toBe(307);
      expect(lucia.invalidateSession).toHaveBeenCalledWith('s1');
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    });
  });
});
