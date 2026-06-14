import type { DmTurnContext } from './coach-handler';
import type { Intent } from '../intent-router/intent-router.service';

/** The access tier a tool requires at the tool boundary (ADR-0011): own-data reads 'any', writes 'active'. */
export type AccessTier = 'any' | 'active';

/**
 * One capability a Spoke exposes (ADR-0032) — the unit the discovery classifier targets, the spoke's
 * `invoke` switches on, and the access gate reads. Making every spoke expose Tools (not just journal)
 * is what turns the two-level *spoke → tool* structure into one uniform shape across the hub.
 */
export interface ToolSpec {
  /** Stable id the intent router emits and the spoke's `invoke` switches on (e.g. 'save_entry'). */
  name: string;
  /** One line for the router catalogue — what picking this tool does (consumed by the registry-built prompt). */
  description: string;
  /** Access tier required to invoke it (ADR-0011): reads of own data 'any', writes/new-logging 'active'. */
  access: AccessTier;
}

/**
 * What a spoke did with a turn: it handled it, or it wants to fall through to the coach. `fallthrough`
 * is how heterogeneity is absorbed honestly — a tilt offer already pending, a capture floor that
 * expired, an unknown tool — without the hub special-casing each spoke.
 */
export type SpokeResult = { kind: 'handled' } | { kind: 'fallthrough' };

/**
 * A DM capability area as a uniform deep module (ADR-0032). Each spoke exposes its tools and two entry
 * points: `invoke(tool, ctx)` for a fresh turn the router classified to this spoke, and `resume(ctx)`
 * for a turn that returns to a two-turn capture floor this spoke armed. Both return a {@link SpokeResult}
 * so the hub can fall through to the coach uniformly. The spoke owns its own `invoke` switch and its
 * capture logic — locality the old `RoutingPlan`/`dispatch` smear did not have.
 */
export interface Spoke {
  /** The intent key this spoke is registered under — a real router intent, checked against the registry key at compile time. */
  readonly intent: Intent;
  /** One line telling the intent router what this spoke is for — fed verbatim into its generated prompt. */
  readonly description: string;
  /** The capabilities this spoke exposes, each with its own access tier. */
  readonly tools: ToolSpec[];
  /**
   * The tool to run when the router names none or one this spoke doesn't expose. Must be a safe choice:
   * journal's is `give_prompt` (never save on a guess), not `save_entry`. Its access tier also gates a
   * coach-fallback or no-tool turn.
   */
  readonly defaultTool: string;
  /** Run a fresh turn the router routed here, on the named tool. Unknown tools fall to the spoke's safe default. */
  invoke(tool: string, ctx: DmTurnContext): Promise<SpokeResult>;
  /** Continue a floor-held capture this spoke armed; `fallthrough` when the floor lapsed. */
  resume(ctx: DmTurnContext): Promise<SpokeResult>;
}
