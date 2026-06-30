import { AccessResolver } from '../access-resolver';
import { prisma, decideAccess, trialGrant } from '@wabi/shared';
import { UserService } from '../../user/user.service';

// Keep the real shared access logic (decideAccess) while mocking only prisma's I/O.
jest.mock('@wabi/shared', () => ({
  ...jest.requireActual('@wabi/shared'),
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

describe('AccessResolver', () => {
  let resolver: AccessResolver;
  let userService: jest.Mocked<UserService>;

  beforeEach(() => {
    jest.clearAllMocks();
    userService = new UserService() as any;
    resolver = new AccessResolver(userService);
  });

  it('returns no access for unknown user', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue(null);
    const result = await resolver.resolve('999');

    expect(result).toEqual({
      hasActiveAccess: false,
      subscriptionStatus: 'canceled',
    });
  });

  it('grants access during active trial', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() + 86400000),
      subscriptionStatus: 'trialing',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(true);
  });

  it('denies access on expired trial with a terminal subscription status', async () => {
    // Regression: this case previously used subscriptionStatus 'trialing' and asserted `true`,
    // so it never actually tested denial. A genuinely expired user has a terminal status.
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'canceled',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(false);
  });

  it('grants access on active stripe subscription', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'active',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(true);
  });

  it('denies access on past_due subscription', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'past_due',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(false);
  });

  it('persists subscriptionStatus (not the derived access flag, which is recomputed on read)', async () => {
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    await resolver.apply('123', { hasActiveAccess: true, subscriptionStatus: 'active' });

    // hasActiveAccess is computed by decideAccess() on every read — it is never persisted, so the
    // write must NOT include it (the column was removed as a dead, drift-prone denormalization).
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { discordId: '123' },
      data: { subscriptionStatus: 'active' },
    });
  });

  describe('resolveAccount (one read → access + consent + timezone)', () => {
    it('derives all three facts from a SINGLE findByDiscordId', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        discordId: '123',
        consentAcceptedAt: new Date('2026-01-01T00:00:00Z'),
        timezone: 'America/New_York',
        trialEndsAt: new Date(Date.now() + 86400000),
        subscriptionStatus: 'trialing',
      });

      const result = await resolver.resolveAccount('123');

      expect(userService.findByDiscordId).toHaveBeenCalledTimes(1); // not a second projected consent read
      expect(result.consented).toBe(true);
      expect(result.timezone).toBe('America/New_York');
      expect(result.access.hasActiveAccess).toBe(true);
    });

    it('is fail-safe — an unknown user is not consented, UTC, no access', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue(null);
      const result = await resolver.resolveAccount('999');
      expect(result).toEqual({
        access: { hasActiveAccess: false, subscriptionStatus: 'canceled' },
        consented: false,
        timezone: 'UTC',
        onboardingCompleted: false,
        improveAreas: [],
        interests: [],
      });
    });

    it('exposes onboardingCompleted + Personalization from the SAME read (no extra query)', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        discordId: '123',
        consentAcceptedAt: new Date('2026-01-01T00:00:00Z'),
        timezone: 'America/New_York',
        trialEndsAt: new Date(Date.now() + 86400000),
        subscriptionStatus: 'trialing',
        onboardingCompletedAt: new Date('2026-01-02T00:00:00Z'),
        improveAreas: ['tilt', 'focus'],
        interests: ['fps'],
      });

      const result = await resolver.resolveAccount('123');

      expect(userService.findByDiscordId).toHaveBeenCalledTimes(1); // onboarding rides the existing read
      expect(result.onboardingCompleted).toBe(true);
      expect(result.improveAreas).toEqual(['tilt', 'focus']);
      expect(result.interests).toEqual(['fps']);
    });

    it('reports onboardingCompleted false when onboardingCompletedAt is null', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        discordId: '123',
        consentAcceptedAt: new Date('2026-01-01T00:00:00Z'),
        timezone: 'UTC',
        trialEndsAt: new Date(Date.now() + 86400000),
        subscriptionStatus: 'trialing',
        onboardingCompletedAt: null,
        improveAreas: [],
        interests: [],
      });

      const result = await resolver.resolveAccount('123');

      expect(result.onboardingCompleted).toBe(false);
    });

    it('never throws on a read failure — degrades to not-consented', async () => {
      (userService.findByDiscordId as jest.Mock).mockRejectedValue(new Error('db down'));
      const result = await resolver.resolveAccount('123');
      expect(result.consented).toBe(false);
      expect(result.access.hasActiveAccess).toBe(false);
    });
  });

  it('records lastStripeEventAt when an event timestamp is supplied', async () => {
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    const eventAt = new Date('2026-06-06T00:00:00Z');
    await resolver.apply('123', { hasActiveAccess: false, subscriptionStatus: 'canceled' }, eventAt);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { discordId: '123' },
      data: {
        subscriptionStatus: 'canceled',
        lastStripeEventAt: eventAt,
      },
    });
  });
});

describe('decideAccess (pure)', () => {
  const now = new Date('2026-06-06T00:00:00Z');
  const past = new Date('2026-06-01T00:00:00Z');
  const future = new Date('2026-06-30T00:00:00Z');

  it('denies access for a null user', () => {
    expect(decideAccess(null, now)).toEqual({
      hasActiveAccess: false,
      subscriptionStatus: 'canceled',
    });
  });

  it('grants access while the app-managed trial is active', () => {
    expect(
      decideAccess({ trialEndsAt: future, subscriptionStatus: 'trialing' }, now).hasActiveAccess,
    ).toBe(true);
  });

  it('grants access for an active stripe subscription even after the trial', () => {
    expect(
      decideAccess({ trialEndsAt: past, subscriptionStatus: 'active' }, now).hasActiveAccess,
    ).toBe(true);
  });

  it('denies access for a trialing status once the trial date has passed (no auto-expiry job exists)', () => {
    // A web Trial captures no card and has no Stripe subscription, so nothing ever flips its status
    // off 'trialing'. Access MUST therefore require trialEndsAt > now — otherwise a lapsed trial keeps
    // free coaching forever (the defect this corrects, ADR-0011).
    expect(
      decideAccess({ trialEndsAt: past, subscriptionStatus: 'trialing' }, now).hasActiveAccess,
    ).toBe(false);
  });

  it('denies access for past_due', () => {
    expect(
      decideAccess({ trialEndsAt: past, subscriptionStatus: 'past_due' }, now).hasActiveAccess,
    ).toBe(false);
  });

  it('denies access for an expired trial with a canceled status', () => {
    expect(
      decideAccess({ trialEndsAt: past, subscriptionStatus: 'canceled' }, now).hasActiveAccess,
    ).toBe(false);
  });
});

describe('trialGrant (pure)', () => {
  it('grants a 7-day trialing window from now by default', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    const grant = trialGrant(now);

    expect(grant.subscriptionStatus).toBe('trialing');
    expect(grant.trialEndsAt.getTime()).toBe(now.getTime() + 7 * 86400000);
  });

  it('honours TRIAL_DAYS when set', () => {
    const prev = process.env.TRIAL_DAYS;
    process.env.TRIAL_DAYS = '14';
    try {
      const now = new Date('2026-06-06T00:00:00Z');
      expect(trialGrant(now).trialEndsAt.getTime()).toBe(now.getTime() + 14 * 86400000);
    } finally {
      if (prev === undefined) delete process.env.TRIAL_DAYS;
      else process.env.TRIAL_DAYS = prev;
    }
  });
});
