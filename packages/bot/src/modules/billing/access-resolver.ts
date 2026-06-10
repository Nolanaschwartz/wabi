import { Injectable } from '@nestjs/common';
import { prisma, decideAccess, type AccessState } from '@wabi/shared';

// decideAccess (the pure Active Access decision) now lives in @wabi/shared so the bot's gate and the
// web dashboard share ONE formula. This service is the bot's I/O wrapper around it.
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
