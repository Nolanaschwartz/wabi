import { prisma } from '@wabi/shared';
import type { AccessState } from './stripe-access-mapper';

export class AccessResolver {
  async resolve(discordId: string): Promise<AccessState> {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      return {
        hasActiveAccess: false,
        subscriptionStatus: 'canceled',
      };
    }

    const trialActive =
      user.trialEndsAt != null && user.trialEndsAt > new Date();
    const stripeActive =
      user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing';

    return {
      hasActiveAccess: trialActive || stripeActive,
      subscriptionStatus: user.subscriptionStatus as AccessState['subscriptionStatus'],
    };
  }

  async apply(discordId: string, state: AccessState): Promise<void> {
    await prisma.user.update({
      where: { discordId },
      data: {
        hasActiveAccess: state.hasActiveAccess,
        subscriptionStatus: state.subscriptionStatus,
      },
    });
  }
}
