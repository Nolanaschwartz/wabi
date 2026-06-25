import { Injectable } from '@nestjs/common';
import { prisma, decideAccess, type AccessState } from '@wabi/shared';
import { UserService } from '../user/user.service';

// decideAccess (the pure Active Access decision) now lives in @wabi/shared so the bot's gate and the
// web dashboard share ONE formula. This service is the bot's I/O wrapper around it.
@Injectable()
export class AccessResolver {
  constructor(private readonly userService: UserService) {}

  async resolve(discordId: string): Promise<AccessState> {
    const user = await this.userService.findByDiscordId(discordId);

    return decideAccess(user, new Date());
  }

  /**
   * The DM entry point's one read: the full User row already carries consent + timezone, so the coaching
   * turn derives the consent gate, the coach-prompt timezone, AND the Active Access decision from a SINGLE
   * findByDiscordId instead of a separate projected consent read plus this one. Fail-safe like the prior
   * consent read: a failed/absent row resolves to not-consented, UTC, and no access — never throws — so a
   * degraded DB shows the setup link rather than crashing the turn (ADR-0011/0021).
   */
  async resolveAccount(
    discordId: string,
  ): Promise<{ access: AccessState; consented: boolean; timezone: string }> {
    const user = await this.userService.findByDiscordId(discordId).catch(() => null);
    return {
      access: decideAccess(user, new Date()),
      consented: !!user?.consentAcceptedAt,
      timezone: user?.timezone ?? 'UTC',
    };
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
