import { Injectable } from '@nestjs/common';
import { CoachHandler, type DmTurnContext } from './coach-handler';
import { JournalDmHandler } from '../journal/journal-dm.handler';
import { JournalSessionService } from '../journal/journal-session.service';
import { extractInlineJournalContent } from '../journal/journal-content';
import type { IntentResult } from '../intent-router/intent-router.service';

/**
 * Minimum router confidence to dispatch a turn AWAY from coaching to a specialised handler. Coaching is
 * the safe fallback, so this is deliberately conservative: below it, an uncertain journal/tilt/mood
 * verdict falls through to the coach rather than risk mis-handling the turn. Tunable from the Langfuse
 * `intent` traces emitted in Slice A2. (θ in the design.)
 */
export const INTENT_DISPATCH_THRESHOLD = 0.75;

/**
 * Dispatch seam for a safe + active DM turn. CoachingService owns the safety floor (tripwire, crisis
 * classifier, access gate, tilt offer) and hands the router only turns that already cleared every
 * gate, plus the intent verdict and whether a pending-journal capture is armed. The router decides
 * which specialised handler answers; coaching is the universal fallback. The crisis floor never moves
 * into the router.
 */
@Injectable()
export class DmRouterService {
  constructor(
    private readonly coachHandler: CoachHandler,
    private readonly journalHandler: JournalDmHandler,
    private readonly journalSession: JournalSessionService,
  ) {}

  /**
   * @param pendingJournal whether a two-turn journal capture is armed for this user (read upstream so
   * the intent-router LLM call could be skipped). When true, THIS turn is the capture: it is consumed
   * and written verbatim, with no re-routing — a mid-capture pivot is still saved as the entry.
   */
  async route(ctx: DmTurnContext, routed: IntentResult, pendingJournal: boolean): Promise<void> {
    // Pending-capture wins over everything (the turn was already screened safe upstream). Consume is an
    // atomic getDel: if the marker expired between the upstream read and now, fall through to normal
    // routing rather than capturing a turn the user no longer expects to be journaled.
    if (pendingJournal && (await this.journalSession.consume(ctx.userId))) {
      await this.journalHandler.handle(ctx, ctx.batch);
      return;
    }

    if (routed.intent === 'journal' && routed.confidence >= INTENT_DISPATCH_THRESHOLD) {
      const content = extractInlineJournalContent(ctx.batch);
      if (content) {
        // One-turn: the message already carries the entry.
        await this.journalHandler.handle(ctx, content);
      } else {
        // Two-turn: bare intent — arm the capture and prompt; the entry is the next message.
        await this.journalHandler.beginConversation(ctx);
      }
      return;
    }

    // Everything else — coach intent, low confidence, or unsupported intent — coaches.
    await this.coachHandler.handle(ctx);
  }
}
