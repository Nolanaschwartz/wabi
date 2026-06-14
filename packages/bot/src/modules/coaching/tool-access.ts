import type { RoutingPlan } from './dm-router.service';

/**
 * The tools the hub's spokes can run, named for the access-tier policy (ADR-0011). `coach` is the hub's
 * own fallback rather than a spoke tool, but it is gated the same way, so it lives here too.
 */
export type Tool = 'coach' | 'give_prompt' | 'save_entry' | 'get_entry' | 'tilt' | 'mood';

/**
 * Access-tier gate at the tool boundary (ADR-0011). Reading the person's OWN data (`get_entry`, and
 * later export) is allowed at ANY tier — a lapsed user never loses read access to what they wrote.
 * Coaching and any new write (`coach`, `give_prompt`, `save_entry`) require ACTIVE access. The hub
 * selects a tool; this decides whether it may run, so the policy lives in one place rather than being
 * re-implemented inside each spoke.
 */
export function toolAllowed(tool: Tool, hasActiveAccess: boolean): boolean {
  if (tool === 'get_entry') return true;
  return hasActiveAccess;
}

/** Map a routing plan to the tool it runs, so the gate can apply {@link toolAllowed}. */
export function planTool(plan: RoutingPlan): Tool {
  switch (plan.kind) {
    case 'coach':
      return 'coach';
    case 'journal-begin':
      return 'give_prompt';
    case 'journal-inline':
    case 'journal-capture':
      return 'save_entry';
    case 'journal-read':
      return 'get_entry';
    case 'tilt':
      return 'tilt';
    case 'mood':
    case 'mood-capture':
      return 'mood';
    default: {
      // Exhaustiveness guard: if a new RoutingPlan kind is added without a case here, this fails the
      // type-check (the assignment to `never`) and, at runtime, throws rather than returning undefined
      // — which toolAllowed would otherwise read as "no tool" and silently deny.
      const _exhaustive: never = plan;
      throw new Error(`planTool: unhandled plan kind ${(plan as RoutingPlan).kind}`);
    }
  }
}
