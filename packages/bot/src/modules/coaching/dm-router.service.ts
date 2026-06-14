import { Injectable } from '@nestjs/common';
import { CoachHandler, type DmTurnContext } from './coach-handler';
import { JournalDmHandler } from '../journal/journal-dm.handler';
import { JournalSessionService } from '../journal/journal-session.service';
import { extractInlineJournalContent } from '../journal/journal-content';
import {
  IntentRouterService,
  type IntentResult,
  type IntentContext,
} from '../intent-router/intent-router.service';

/**
 * Minimum router confidence to dispatch a turn AWAY from coaching to a specialised handler. Coaching is
 * the safe fallback, so this is deliberately conservative: below it, an uncertain journal/tilt/mood
 * verdict falls through to the coach rather than risk mis-handling the turn. Tunable from the Langfuse
 * `intent` traces emitted in Slice A2. (θ in the design.)
 */
export const INTENT_DISPATCH_THRESHOLD = 0.75;

/**
 * Where a safe turn is headed, decided by {@link DmRouterService.prepare} and executed by
 * {@link DmRouterService.dispatch}. The plan is side-effect-free so it can be computed inside the
 * caller's parallel block and the actual handler call deferred to the safe path.
 *
 * - `journal-capture` — a two-turn capture is armed; dispatch consumes the marker and writes the turn.
 * - `journal-inline`  — a confident journal intent whose message already carries the entry.
 * - `journal-begin`   — a confident bare journal intent; dispatch arms the capture and prompts.
 * - `coach`           — the universal fallback (coach intent, sub-θ, or an unsupported intent).
 */
export type RoutingPlan =
  | { kind: 'journal-capture' }
  | { kind: 'journal-inline'; content: string }
  | { kind: 'journal-begin' }
  | { kind: 'coach' };

/** A routing plan plus the raw intent verdict it derived from (kept for the observe-only intent trace). */
export interface RoutingDecision {
  plan: RoutingPlan;
  verdict: IntentResult;
}

/**
 * Dispatch seam for a DM turn. CoachingService owns the safety floor (tripwire, crisis classifier,
 * access gate, tilt offer) and never lets the router touch it. The router owns the whole routing
 * decision: it reads whether a journal capture is armed, runs the intent classifier, applies θ, and
 * extracts inline journal content — all in {@link prepare}, which runs inside CoachingService's parallel
 * block so it adds no serial latency. {@link dispatch} then runs the resulting plan on the safe path.
 * The crisis floor never moves into the router; coaching is the universal fallback.
 */
@Injectable()
export class DmRouterService {
  constructor(
    private readonly coachHandler: CoachHandler,
    private readonly journalHandler: JournalDmHandler,
    private readonly journalSession: JournalSessionService,
    private readonly intentRouter: IntentRouterService,
  ) {}

  /**
   * Decide where a turn goes without acting on it. Safe to run in parallel with the crisis classifier.
   * When a two-turn journal capture is armed, the dispatch is predetermined so the intent LLM is skipped
   * entirely and a synthetic verdict is returned (so the upstream trace still records a journal turn).
   */
  async prepare(userId: string, batch: string, context: IntentContext): Promise<RoutingDecision> {
    // Cheap, fail-soft Redis read. When set, THIS turn is the entry: the intent-router LLM is pointless.
    if (await this.journalSession.isPending(userId)) {
      return { plan: { kind: 'journal-capture' }, verdict: { intent: 'journal', confidence: 1 } };
    }

    const verdict = await this.intentRouter.route(batch, context);

    if (verdict.intent === 'journal' && verdict.confidence >= INTENT_DISPATCH_THRESHOLD) {
      const content = extractInlineJournalContent(batch);
      return {
        plan: content ? { kind: 'journal-inline', content } : { kind: 'journal-begin' },
        verdict,
      };
    }

    // Coach intent, low confidence, or an unsupported intent (tilt/mood) — coaching is the fallback.
    return { plan: { kind: 'coach' }, verdict };
  }

  /** Run a prepared plan on the safe path (the turn has already cleared every safety/access gate). */
  async dispatch(ctx: DmTurnContext, plan: RoutingPlan): Promise<void> {
    switch (plan.kind) {
      case 'journal-capture': {
        // Atomic getDel: if the marker expired between prepare() and now, fall through to coaching.
        // The intent LLM was skipped, so there is no verdict to route on — coaching is the fallback.
        if (await this.journalSession.consume(ctx.userId)) {
          await this.journalHandler.handle(ctx, ctx.batch);
          return;
        }
        await this.coachHandler.handle(ctx);
        return;
      }
      case 'journal-inline':
        await this.journalHandler.handle(ctx, plan.content);
        return;
      case 'journal-begin':
        await this.journalHandler.beginConversation(ctx);
        return;
      case 'coach':
        await this.coachHandler.handle(ctx);
        return;
    }
  }

  /**
   * Drop a pending-journal capture marker. Called by CoachingService's crisis branch when a capture was
   * armed: dispatch never runs on a crisis turn, so the crisis text must never reach the journal writer.
   * Best-effort — a lingering marker would expire on its TTL anyway.
   */
  async clearPending(userId: string): Promise<void> {
    await this.journalSession.clear(userId);
  }
}
