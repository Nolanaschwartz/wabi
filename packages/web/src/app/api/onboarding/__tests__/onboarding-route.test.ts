import { POST } from '../route';

// Thin adapter: auth-guard → parse body → delegate to completeOnboarding. The validation
// invariants (≥1 area, slug dropping, no billing writes) are tested at onboarding-profile.test.ts.
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('@/lib/auth-guard', () => ({ requireAuthenticated: jest.fn() }));
jest.mock('@/lib/onboarding-profile', () => ({ completeOnboarding: jest.fn() }));

const { requireAuthenticated } = require('@/lib/auth-guard');
const { completeOnboarding } = require('@/lib/onboarding-profile');

function reqWith(body: unknown): any {
  return { json: async () => body };
}

describe('POST /api/onboarding (thin adapter)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 and does not write when unauthenticated', async () => {
    requireAuthenticated.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const res = await POST(reqWith({}));

    expect(res.status).toBe(401);
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it('delegates to completeOnboarding with the user id and parsed input, returns 200 on ok', async () => {
    requireAuthenticated.mockResolvedValue({ id: 'u1' });
    completeOnboarding.mockResolvedValue({ ok: true });

    const res = await POST(
      reqWith({
        locale: 'en-GB',
        timezone: 'Europe/London',
        improveAreas: ['tilt'],
        interests: ['fps'],
      }),
    );

    expect(res.status).toBe(200);
    expect(completeOnboarding).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      { locale: 'en-GB', timezone: 'Europe/London', improveAreas: ['tilt'], interests: ['fps'] },
      expect.any(Date),
    );
  });

  it('returns 400 when the brain rejects the input', async () => {
    requireAuthenticated.mockResolvedValue({ id: 'u1' });
    completeOnboarding.mockResolvedValue({ ok: 'invalid', reason: 'at least one improvement area is required' });

    const res = await POST(reqWith({ improveAreas: [], interests: [] }));

    expect(res.status).toBe(400);
  });
});
