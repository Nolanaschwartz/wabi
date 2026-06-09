import { AccessResolver, decideAccess } from '../access-resolver';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('AccessResolver', () => {
  let resolver: AccessResolver;

  beforeEach(() => {
    resolver = new AccessResolver();
    jest.clearAllMocks();
  });

  it('returns no access for unknown user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await resolver.resolve('999');

    expect(result).toEqual({
      hasActiveAccess: false,
      subscriptionStatus: 'canceled',
    });
  });

  it('grants access during active trial', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
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
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'canceled',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(false);
  });

  it('grants access on active stripe subscription', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'active',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(true);
  });

  it('denies access on past_due subscription', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
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

  it('grants access for trialing stripe status', () => {
    expect(
      decideAccess({ trialEndsAt: past, subscriptionStatus: 'trialing' }, now).hasActiveAccess,
    ).toBe(true);
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
