import { POST as acceptPost } from '../accept/route';
import { POST as declinePost } from '../decline/route';
import { PENDING_CONSENT_COOKIE } from '@/lib/pending-consent';

// Thin adapters: accept delegates the (sole) User-creating write to the onboarding
// module; decline is a pure cookie drop. The provisioning invariants (no write before a
// valid token, idempotency, trial window) are tested at onboarding.test.ts.
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('@/lib/onboarding', () => ({ provisionConsentedUser: jest.fn() }));
jest.mock('@/lib/session', () => ({ establishSession: jest.fn() }));

const { provisionConsentedUser } = require('@/lib/onboarding');
const { establishSession } = require('@/lib/session');

function reqWith(cookieValue?: string): any {
  return {
    cookies: {
      get: (name: string) =>
        name === PENDING_CONSENT_COOKIE && cookieValue ? { value: cookieValue } : undefined,
    },
  };
}

describe('Consent routes (thin adapters)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
  });

  describe('accept', () => {
    it('returns 401 and establishes no session when provisioning rejects the token', async () => {
      provisionConsentedUser.mockResolvedValue(null);

      const res = await acceptPost(reqWith(undefined));

      expect(res.status).toBe(401);
      expect(establishSession).not.toHaveBeenCalled();
    });

    it('establishes a session and consumes the pending cookie on success', async () => {
      provisionConsentedUser.mockResolvedValue({ userId: 'u1' });

      const res = await acceptPost(reqWith('valid-token'));

      expect(res.status).toBe(200);
      expect(establishSession).toHaveBeenCalledWith('u1', expect.anything());
      expect(res.headers.get('set-cookie') ?? '').toContain(`${PENDING_CONSENT_COOKIE}=;`);
    });
  });

  describe('decline', () => {
    it('persists nothing and clears the pending cookie (no decline-time delete)', async () => {
      const res = await declinePost();

      expect(res.status).toBe(200);
      expect(provisionConsentedUser).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie') ?? '').toContain(`${PENDING_CONSENT_COOKIE}=;`);
    });
  });
});
