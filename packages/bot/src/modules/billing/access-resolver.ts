import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import type { AccessState } from './stripe-access-mapper';

/**
 * Pure access decision (issue #38). No I/O — given the user's billing fields and the current
 * time, returns the access state. Formula: access = (now < trialEndsAt) OR
 * (stripeStatus ∈ {active, trialing}). Kept separate from `resolve()` so it can be unit-tested
 * over inputs without a database.
 */
export function decideAccess(
  user: { trialEndsAt: Date | null; subscriptionStatus: string } | null,
  now: Date,
): AccessState {
  if (!user) {
    return { hasActiveAccess: false, subscriptionStatus: 'canceled' };
  }

  const trialActive = user.trialEndsAt != null && user.trialEndsAt > now;
  const stripeActive =
    user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing';

  return {
    hasActiveAccess: trialActive || stripeActive,
    subscriptionStatus: user.subscriptionStatus as AccessState['subscriptionStatus'],
  };
}

@Injectable()
export class AccessResolver {
  async resolve(discordId: string): Promise<AccessState> {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    return decideAccess(user, new Date());
  }

  /**
   * Persist the resolved state. When `eventAt` is supplied (from a Stripe webhook), it is
   * recorded as the latest applied event time so the out-of-order guard (#27) can drop any
   * subsequently-delivered, older event.
   */
  async apply(discordId: string, state: AccessState, eventAt?: Date): Promise<void> {
    // Persist only subscriptionStatus (+ event watermark). hasActiveAccess is derived by
    // decideAccess() on every read, so storing it would be a dead, drift-prone denormalization.
    await prisma.user.update({
      where: { discordId },
      data: {
        subscriptionStatus: state.subscriptionStatus,
        ...(eventAt ? { lastStripeEventAt: eventAt } : {}),
      },
    });
  }
}
