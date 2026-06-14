import { Injectable } from '@nestjs/common';
import { MoodService } from './mood.service';
import { parseMoodRating } from './mood-rating';
import { SpokeSessionService } from '../spoke-session/spoke-session.service';
import type { DmTurnContext } from '../coaching/coach-handler';

/**
 * The mood spoke, a two-turn capture (mirrors journal give_prompt → capture). The hub routes a mood
 * intent here to PROMPT for a 1–5 and arm the floor; the person's next turn is routed straight back as
 * the rating. Safety and access are upstream; mood logging is gated active-only at the tool boundary.
 */
@Injectable()
export class MoodDmHandler {
  constructor(
    private readonly mood: MoodService,
    private readonly spokeSession: SpokeSessionService,
  ) {}

  /** Turn 1: ask for a rating and arm the mood floor. Writes nothing — the rating is the NEXT turn. */
  async promptForRating(ctx: DmTurnContext): Promise<void> {
    await this.spokeSession.setActive(ctx.userId, 'mood');
    await ctx.message.reply('How are you feeling right now, on a 1–5? (1 = rough, 5 = great)');
  }

  /** Turn 2 (floor claimed): parse the rating, log it, confirm with the 7-day trend. Invalid → nudge. */
  async capture(ctx: DmTurnContext): Promise<void> {
    const rating = parseMoodRating(ctx.batch);
    if (rating === null) {
      await ctx.message.reply("I didn't catch a number 1–5 — no worries, you can log your mood anytime.");
      return;
    }
    const emoji = MoodService.ratingToEmoji(rating);
    // Structured-only write: rating + emoji, NEVER a free-text note. The capture turn is already
    // crisis-screened upstream (the coaching classifier runs before dispatch), and with no minable text
    // there is nothing for InnerStateLogger to screen or derive — so a direct create() is the rating-only
    // equivalent of /feeling and upholds the screened-record invariant (ADR-0028/0029). If this spoke ever
    // captures a note, it must route through InnerStateLoggerService instead of calling create() directly.
    await this.mood.create(ctx.userId, { rating, emoji });
    const avg = await this.mood.trend(ctx.userId);
    const trendLine = avg > 0 ? ` Your 7-day average is ${avg}.` : '';
    await ctx.message.reply(`Logged ${emoji} (${rating}/5).${trendLine}`);
  }
}
