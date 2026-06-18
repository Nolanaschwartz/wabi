import { Injectable } from '@nestjs/common';
import { CoachHandler, type DmTurnContext } from './coach-handler';
import { JournalDmHandler } from '../journal/journal-dm.handler';
import { TiltDmHandler } from '../tilt/tilt-dm.handler';
import { MoodDmHandler } from '../mood/mood-dm.handler';
import { SpokeSessionService } from '../spoke-session/spoke-session.service';
import type { Spoke, AccessTier } from './spoke';
import type { GenerationCallTelemetry } from '@wabi/shared/generate';
import {
  IntentRouterService,
  type IntentResult,
  type IntentContext,
  type Intent,
  type SpokeCatalogue,
  type ToolArgs,
} from '../intent-router/intent-router.service';

/**
 * Minimum router confidence to dispatch a turn AWAY from coaching to a specialised spoke. Coaching is
 * the safe fallback, so this is deliberately conservative: below it, an uncertain journal/tilt/mood
 * verdict falls through to the coach rather than risk mis-handling the turn. Tunable from the Langfuse
 * `intent` traces. (θ in the design.)
 */
export const INTENT_DISPATCH_THRESHOLD = 0.75;

/**
 * Where a safe turn is headed, decided by {@link DmRouterService.prepare} and executed by
 * {@link DmRouterService.dispatch}. The plan is side-effect-free so it can be computed inside the
 * caller's parallel block and the actual spoke call deferred to the safe path.
 *
 * - `invoke` — a fresh turn the router classified to a spoke's named tool (coach is the fallback tool).
 * - `resume` — a turn returning to a two-turn capture floor the named spoke armed.
 *
 * The old per-spoke union (`journal-inline`, `mood-capture`, …) collapsed to these two: a `(spoke, tool)`
 * pair the registry dispatches uniformly (ADR-0032).
 */
export type RoutingPlan =
  | { kind: 'invoke'; intent: Intent; tool: string; args?: ToolArgs }
  | { kind: 'resume'; intent: Intent };

/**
 * A routing plan, the raw verdict it derived from (for the intent trace), and the access
 * tier the plan's tool requires — read once from the registry here so the upstream gate is a trivial
 * field check, not a second tool lookup (ADR-0011/0032).
 *
 * `isCapture` is the stable name for "this turn returns to a held capture floor" — the router's own
 * fact, so the crisis-safety branch can decide to clear the floor without reading the hub-internal
 * `plan.kind` shape. Reshaping `RoutingPlan` then can't silently break the floor-clear (ADR-0030).
 */
export interface RoutingDecision {
  plan: RoutingPlan;
  verdict: IntentResult;
  access: AccessTier;
  isCapture: boolean;
  /**
   * Model + token usage of the intent-router LLM call that produced `verdict`, for the `intent` trace
   * span. Absent on a capture resume — that path returns a synthetic verdict and skips the LLM, so there
   * is no model to attribute.
   */
  verdictTelemetry?: GenerationCallTelemetry;
}

/**
 * The hub of the hub-and-spoke router. CoachingService owns the safety floor (tripwire, crisis
 * classifier, access gate, tilt offer) and never lets the hub touch it. The hub owns the whole routing
 * decision through ONE registry (`Record<Intent, Spoke>`): on a fresh turn it picks a spoke via the
 * discovery classifier and θ, or falls through to coach — the universal fallback; when a spoke holds the
 * floor (SpokeSession), the turn is routed straight back to it and the discovery LLM is skipped. All of
 * this runs in {@link prepare}, inside CoachingService's parallel block so it adds no serial latency;
 * {@link dispatch} then runs the resulting plan, and any spoke `fallthrough` lands on coach. Adding a
 * spoke = registering one {@link Spoke}; adding a tool = one ToolSpec plus a case in that spoke's
 * `invoke`. The hub and the access gate do not change. The crisis floor never moves into the hub.
 */
@Injectable()
export class DmRouterService {
  /** The single home of the hub's wiring — compile-time total over every Intent (no silent drift). */
  private readonly registry: Record<Intent, Spoke>;

  /**
   * The registry projected to the router catalogue. The registry is immutable after construction, so
   * this is computed ONCE here rather than rebuilt on every prepare() (every DM turn, inside the
   * classifier-latency window).
   */
  private readonly catalogue: SpokeCatalogue;

  constructor(
    coachHandler: CoachHandler,
    journalHandler: JournalDmHandler,
    private readonly spokeSession: SpokeSessionService,
    private readonly intentRouter: IntentRouterService,
    tiltHandler: TiltDmHandler,
    moodHandler: MoodDmHandler,
  ) {
    this.registry = {
      coach: coachHandler,
      journal: journalHandler,
      tilt: tiltHandler,
      mood: moodHandler,
    };
    this.catalogue = Object.values(this.registry).map((spoke) => ({
      intent: spoke.intent,
      description: spoke.description,
      tools: spoke.tools.map((t) => ({ name: t.name, description: t.description })),
    }));
  }

  /**
   * Decide where a turn goes without acting on it. Safe to run in parallel with the crisis classifier.
   * When a capture floor is held, the dispatch is predetermined: the intent LLM is skipped and a
   * synthetic verdict is returned (so the upstream trace still records the spoke turn).
   */
  async prepare(userId: string, batch: string, context: IntentContext): Promise<RoutingDecision> {
    // Cheap, fail-soft Redis read. When a spoke holds the floor, THIS turn is routed straight back to it
    // (the discovery LLM is pointless and is skipped) — the deterministic half of the discovery-vs-flow
    // split. A capture resume is always a write, so it is gated active-only (ADR-0011).
    const activeSpoke = await this.spokeSession.active(userId);
    if (this.isIntent(activeSpoke)) {
      return {
        plan: { kind: 'resume', intent: activeSpoke },
        verdict: { intent: activeSpoke, confidence: 1 },
        access: 'active',
        isCapture: true,
      };
    }

    // Capture the router call's model/usage out-of-band so the verdict stays its only return value.
    let verdictTelemetry: GenerationCallTelemetry | undefined;
    const verdict = await this.intentRouter.route(batch, this.catalogue, context, (t) => {
      verdictTelemetry = t;
    });

    // A confident, non-coach verdict for a registered spoke routes to that spoke's tool — the router's
    // chosen tool when the spoke exposes it, else the spoke's safe default (e.g. journal → give_prompt,
    // so the hub never saves on a guess). The tool carries its own access tier (ADR-0032).
    if (
      verdict.intent !== 'coach' &&
      this.isIntent(verdict.intent) &&
      verdict.confidence >= INTENT_DISPATCH_THRESHOLD
    ) {
      const spoke = this.registry[verdict.intent];
      const tool = this.resolveTool(spoke, verdict.tool);
      return {
        // Carry any router-extracted tool args (e.g. mood's rating) so the spoke can act in one shot.
        plan: { kind: 'invoke', intent: verdict.intent, tool, args: verdict.args },
        verdict,
        access: this.toolAccess(spoke, tool),
        isCapture: false,
        verdictTelemetry,
      };
    }

    // Coach intent, or any sub-θ verdict — coaching is the universal fallback.
    const coach = this.registry.coach;
    return {
      plan: { kind: 'invoke', intent: 'coach', tool: coach.defaultTool },
      verdict,
      access: this.toolAccess(coach, coach.defaultTool),
      isCapture: false,
      verdictTelemetry,
    };
  }

  /** Run a prepared plan on the safe path (the turn has already cleared every safety/access gate). */
  async dispatch(ctx: DmTurnContext, plan: RoutingPlan): Promise<void> {
    const spoke = this.registry[plan.intent];
    const result =
      plan.kind === 'resume' ? await spoke.resume(ctx) : await spoke.invoke(plan.tool, ctx, plan.args);

    // A spoke that declines the turn (tilt offer pending, crisis aftermath, capture floor expired,
    // unknown tool) falls through to coach — the one universal fallback, uniform across every spoke.
    if (result.kind === 'fallthrough') {
      await this.registry.coach.invoke('coach', ctx);
    }
  }

  /**
   * Drop a pending capture marker. Called by CoachingService's crisis branch when a capture floor was
   * held (a `resume` plan): dispatch never runs on a crisis turn, so the crisis text must never reach a
   * spoke writer. Best-effort — a lingering marker would expire on its TTL anyway.
   */
  async clearPending(userId: string): Promise<void> {
    await this.spokeSession.clear(userId);
  }

  /** The router's chosen tool when the spoke exposes it, else the spoke's safe default. */
  private resolveTool(spoke: Spoke, requested?: string): string {
    return requested && spoke.tools.some((t) => t.name === requested) ? requested : spoke.defaultTool;
  }

  /** The access tier a spoke's tool requires; an unknown tool defaults to the stricter `active`. */
  private toolAccess(spoke: Spoke, toolName: string): AccessTier {
    return spoke.tools.find((t) => t.name === toolName)?.access ?? 'active';
  }

  private isIntent(value: string | null): value is Intent {
    return value !== null && value in this.registry;
  }
}
