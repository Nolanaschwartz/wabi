import { Injectable } from '@nestjs/common';
import { TiltService } from './tilt.service';
import type { DmTurnContext } from '../coaching/coach-handler';

/**
 * The tilt spoke. The hub routes here when the discovery classifier judges a turn as tilt (≥θ) and the
 * inline keyword offer (CoachingService.maybeOffer) did not already fire. It offers a Tilt Session — the
 * person stays in control (accept/decline), never auto-started. Safety and access are upstream; crisis
 * aftermath suppression is handled by the hub, which coaches instead of routing here during aftermath.
 */
@Injectable()
export class TiltDmHandler {
  constructor(private readonly tilt: TiltService) {}

  /**
   * Offer a tilt session for a classifier-detected tilt turn. Returns true if it offered (and replied),
   * false if an offer was already pending — in which case the hub falls back to coaching this turn.
   */
  async handle(ctx: DmTurnContext): Promise<boolean> {
    const message = this.tilt.offerFromIntent(ctx.userId, ctx.batch);
    if (!message) return false;
    await ctx.message.reply(message);
    return true;
  }
}
