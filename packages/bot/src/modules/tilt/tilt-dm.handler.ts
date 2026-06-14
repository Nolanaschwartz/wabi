import { Injectable } from '@nestjs/common';
import { TiltService } from './tilt.service';
import type { DmTurnContext } from '../coaching/coach-handler';
import type { Spoke, SpokeResult, ToolSpec } from '../coaching/spoke';

/**
 * The tilt spoke. The hub routes here when the discovery classifier judges a turn as tilt (≥θ) and the
 * inline keyword offer (CoachingService.maybeOffer) did not already fire. It offers a Tilt Session — the
 * person stays in control (accept/decline), never auto-started. Safety and access are upstream. The
 * spoke owns its own crisis-aftermath suppression and its "offer already pending" case, both as
 * `fallthrough` → coach (ADR-0032), rather than the hub special-casing them.
 */
@Injectable()
export class TiltDmHandler implements Spoke {
  constructor(private readonly tilt: TiltService) {}

  readonly intent = 'tilt';
  readonly description = 'they want help calming gameplay frustration';
  readonly defaultTool = 'offer_session';

  readonly tools: ToolSpec[] = [
    { name: 'offer_session', description: 'Offer a tilt-reset session for gameplay frustration', access: 'active' },
  ];

  /**
   * Offer a tilt session for a classifier-detected tilt turn. Suppressed during crisis aftermath (parity
   * with CoachingService.maybeOffer) and when an offer is already pending — both fall through to coach.
   */
  async invoke(_tool: string, ctx: DmTurnContext): Promise<SpokeResult> {
    if (ctx.inAftermath) return { kind: 'fallthrough' };
    return (await this.handle(ctx)) ? { kind: 'handled' } : { kind: 'fallthrough' };
  }

  /** Tilt arms no capture floor, so a turn never resumes into it — fall through to coach if asked. */
  async resume(_ctx: DmTurnContext): Promise<SpokeResult> {
    return { kind: 'fallthrough' };
  }

  /**
   * Offer a tilt session for a classifier-detected tilt turn. Returns true if it offered (and replied),
   * false if an offer was already pending — in which case the spoke falls through to coaching this turn.
   */
  async handle(ctx: DmTurnContext): Promise<boolean> {
    const message = this.tilt.offerFromIntent(ctx.userId, ctx.batch);
    if (!message) return false;
    await ctx.message.reply(message);
    return true;
  }
}
