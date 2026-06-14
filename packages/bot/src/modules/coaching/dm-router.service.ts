import { Injectable } from '@nestjs/common';
import { CoachHandler, type DmTurnContext } from './coach-handler';
import { JournalDmHandler } from '../journal/journal-dm.handler';
import { TiltDmHandler } from '../tilt/tilt-dm.handler';
import { MoodDmHandler } from '../mood/mood-dm.handler';
import { SpokeSessionService } from '../spoke-session/spoke-session.service';
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
 * - `journal-inline`  — a confident journal intent whose message already carries the entry (save_entry).
 * - `journal-begin`   — a confident bare/prompt-request journal intent; dispatch prompts + arms (give_prompt).
 * - `journal-read`    — a confident read-back request; dispatch reads the latest entry (get_entry).
 * - `tilt`            — a confident tilt intent; dispatch offers a Tilt Session (or coaches in aftermath).
 * - `mood`            — a confident mood intent; dispatch prompts for a 1–5 and arms the mood floor.
 * - `mood-capture`    — the mood floor is held; dispatch consumes it and logs the rating turn.
 * - `coach`           — the universal fallback (coach intent, sub-θ, or an unsupported intent).
 */
export type RoutingPlan =
  | { kind: 'journal-capture' }
  | { kind: 'journal-inline'; content: string }
  | { kind: 'journal-begin' }
  | { kind: 'journal-read' }
  | { kind: 'tilt' }
  | { kind: 'mood' }
  | { kind: 'mood-capture' }
  | { kind: 'coach' };

/** A routing plan plus the raw intent verdict it derived from (kept for the observe-only intent trace). */
export interface RoutingDecision {
  plan: RoutingPlan;
  verdict: IntentResult;
}

/**
 * The hub of the hub-and-spoke router. CoachingService owns the safety floor (tripwire, crisis
 * classifier, access gate, tilt offer) and never lets the hub touch it. The hub owns the whole routing
 * decision: on a fresh turn it picks a spoke (journal today; tilt/mood follow) via the discovery
 * classifier and θ, or falls through to coaching — the universal fallback. When a spoke holds the floor
 * (SpokeSession), continuity is deterministic: the turn is routed straight back to that spoke and the
 * discovery LLM is skipped (the discovery-vs-flow split). All of this runs in {@link prepare}, inside
 * CoachingService's parallel block so it adds no serial latency; {@link dispatch} then runs the
 * resulting plan on the safe path. The crisis floor never moves into the hub.
 */
@Injectable()
export class DmRouterService {
  constructor(
    private readonly coachHandler: CoachHandler,
    private readonly journalHandler: JournalDmHandler,
    private readonly spokeSession: SpokeSessionService,
    private readonly intentRouter: IntentRouterService,
    private readonly tiltHandler: TiltDmHandler,
    private readonly moodHandler: MoodDmHandler,
  ) {}

  /**
   * Decide where a turn goes without acting on it. Safe to run in parallel with the crisis classifier.
   * When a two-turn journal capture is armed, the dispatch is predetermined so the intent LLM is skipped
   * entirely and a synthetic verdict is returned (so the upstream trace still records a journal turn).
   */
  async prepare(userId: string, batch: string, context: IntentContext): Promise<RoutingDecision> {
    // Cheap, fail-soft Redis read. When a spoke holds the floor, THIS turn is routed straight back to
    // it (the discovery LLM is pointless and is skipped) — the deterministic half of the discovery-vs-
    // flow split. journal and mood arm the floor for their two-turn captures.
    const activeSpoke = await this.spokeSession.active(userId);
    if (activeSpoke === 'journal') {
      return { plan: { kind: 'journal-capture' }, verdict: { intent: 'journal', confidence: 1 } };
    }
    if (activeSpoke === 'mood') {
      return { plan: { kind: 'mood-capture' }, verdict: { intent: 'mood', confidence: 1 } };
    }

    const verdict = await this.intentRouter.route(batch, context);

    if (verdict.intent === 'tilt' && verdict.confidence >= INTENT_DISPATCH_THRESHOLD) {
      return { plan: { kind: 'tilt' }, verdict };
    }

    if (verdict.intent === 'mood' && verdict.confidence >= INTENT_DISPATCH_THRESHOLD) {
      return { plan: { kind: 'mood' }, verdict };
    }

    if (verdict.intent === 'journal' && verdict.confidence >= INTENT_DISPATCH_THRESHOLD) {
      // The journal spoke's tools, chosen by the discovery classifier (the hub never guesses from regex):
      // save_entry writes the message verbatim as the entry; get_entry reads the latest one back;
      // give_prompt — and the safe default for any missing/unknown tool — prompts and arms the floor,
      // persisting nothing. Defaulting to give_prompt means the hub never saves on a guess.
      if (verdict.tool === 'save_entry') {
        return { plan: { kind: 'journal-inline', content: batch }, verdict };
      }
      if (verdict.tool === 'get_entry') {
        return { plan: { kind: 'journal-read' }, verdict };
      }
      return { plan: { kind: 'journal-begin' }, verdict };
    }

    // Coach intent, or any sub-θ verdict — coaching is the universal fallback.
    return { plan: { kind: 'coach' }, verdict };
  }

  /** Run a prepared plan on the safe path (the turn has already cleared every safety/access gate). */
  async dispatch(ctx: DmTurnContext, plan: RoutingPlan): Promise<void> {
    switch (plan.kind) {
      case 'journal-capture': {
        // Atomic getDel: if the floor expired between prepare() and now, fall through to coaching.
        // The intent LLM was skipped, so there is no verdict to route on — coaching is the fallback.
        if ((await this.spokeSession.consume(ctx.userId)) === 'journal') {
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
      case 'journal-read':
        await this.journalHandler.getEntry(ctx);
        return;
      case 'tilt':
        // Tilt offers are suppressed during crisis aftermath (parity with maybeOffer); and when an offer
        // is already pending the spoke declines (returns false) → coaching is the fallback either way.
        if (!ctx.inAftermath && (await this.tiltHandler.handle(ctx))) return;
        await this.coachHandler.handle(ctx);
        return;
      case 'mood':
        await this.moodHandler.promptForRating(ctx);
        return;
      case 'mood-capture': {
        // Atomic getDel mirrors journal-capture: a floor that expired between prepare() and now falls
        // through to coaching (the intent LLM was skipped, so there is no verdict to route on).
        if ((await this.spokeSession.consume(ctx.userId)) === 'mood') {
          await this.moodHandler.capture(ctx);
          return;
        }
        await this.coachHandler.handle(ctx);
        return;
      }
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
    await this.spokeSession.clear(userId);
  }
}
