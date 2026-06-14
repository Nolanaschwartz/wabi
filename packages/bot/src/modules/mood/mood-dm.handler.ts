import { Injectable } from '@nestjs/common';
import { MoodService } from './mood.service';
import { parseMoodRating } from './mood-rating';
import { SpokeSessionService } from '../spoke-session/spoke-session.service';
import type { DmTurnContext } from '../coaching/coach-handler';
import type { Spoke, SpokeResult, ToolSpec } from '../coaching/spoke';

/**
 * The mood spoke, a two-turn capture (mirrors journal give_prompt → capture). The hub routes a mood
 * intent here to PROMPT for a 1–5 and arm the floor; the person's next turn is routed straight back as
 * the rating. Safety and access are upstream; mood logging is gated active-only at the tool boundary.
 */
@Injectable()
export class MoodDmHandler implements Spoke {
  constructor(
    private readonly mood: MoodService,
    private readonly spokeSession: SpokeSessionService,
  ) {}

  readonly intent = 'mood';
  readonly description = 'they want to log how they feel';
  readonly defaultTool = 'log_mood';

  readonly tools: ToolSpec[] = [
    { name: 'log_mood', description: 'Ask for a 1–5 mood rating and log it', access: 'active' },
  ];

  /** A fresh mood turn: prompt for the rating and arm the floor. Unknown tools take the same safe path. */
  async invoke(_tool: string, ctx: DmTurnContext): Promise<SpokeResult> {
    await this.promptForRating(ctx);
    return { kind: 'handled' };
  }

  /**
   * Continue the mood capture: atomically consume the floor and log the rating turn. A floor that
   * expired between prepare() and now falls through to coaching (the intent LLM was skipped).
   */
  async resume(ctx: DmTurnContext): Promise<SpokeResult> {
    if ((await this.spokeSession.consume(ctx.userId)) === 'mood') {
      await this.capture(ctx);
      return { kind: 'handled' };
    }
    return { kind: 'fallthrough' };
  }

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
