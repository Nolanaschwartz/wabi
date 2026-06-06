import { AccessResolver } from '../access-resolver';
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

  it('denies access on expired trial', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      trialEndsAt: new Date(Date.now() - 86400000),
      subscriptionStatus: 'trialing',
    });

    const result = await resolver.resolve('123');
    expect(result.hasActiveAccess).toBe(true);
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

  it('applies state updates', async () => {
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    await resolver.apply('123', { hasActiveAccess: true, subscriptionStatus: 'active' });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { discordId: '123' },
      data: { hasActiveAccess: true, subscriptionStatus: 'active' },
    });
  });
});
