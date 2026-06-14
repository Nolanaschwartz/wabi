# Spokes are uniform deep modules that expose Tools; the hub routes through one registry

Each DM **spoke** (journal, mood, tilt, coach) becomes a uniform deep module exposing a set of **Tools** and two methods — `invoke(tool, ctx)` for a fresh turn and `resume(ctx)` for a floor-held continuation — each returning `SpokeResult = { kind: 'handled' } | { kind: 'fallthrough' }`. A registry keyed by intent (`Record<Intent, Spoke>`) replaces the wiring previously smeared across the `RoutingPlan` union, `prepare()`, `dispatch()`, the `Tool` type, `planTool()`, and the intent-router prompt. The intent router builds its classifier prompt **from the registry catalogue**, so a new Tool is declared in exactly one place.

## Why

- **A spoke had no single home.** Adding or changing a spoke touched six structures across five files, kept in sync by hand: the `RoutingPlan` union, `prepare()`'s intent→plan mapping, `dispatch()`'s switch, the `Tool` type, `planTool()`/`toolAllowed()`, and the intent-router's hand-maintained prompt — plus a name-keyed capture check in `CoachingService`. A spoke's identity (intent, tools, access tiers, capture behaviour) was scattered, not localised.

- **Generalising Tools makes the registry a deep consolidation, not a shallow abstraction.** Tools were journal-only special-casing. Making every spoke expose Tools turns the two-level structure — *spoke = capability area, tool = capability within it* — into one real, uniform shape shared by all spokes. The deletion test confirms it: remove the registry and the `(spoke, tool)` routing reappears smeared across `prepare`/`dispatch`/`planTool`/the router prompt for every spoke. Complexity concentrates; it does not merely move.

- **Heterogeneity is absorbed honestly.** Tilt's "offer already pending" and journal-capture's "floor expired" both collapse to `fallthrough` (→ coach). The two-turn capture floor becomes the uniform `resume()`. The hub shrinks from eight `RoutingPlan` kinds plus seven bespoke handler methods to two methods and a result union; each spoke gains locality, owning its own `invoke` switch and capture logic.

## Scope and bounds

- The registry is `Record<Intent, Spoke>` — **compile-time total**, preserving today's exhaustiveness guarantee (no silent drift between intent, tool, and plan).
- **Access tier moves onto each `ToolSpec`** (`'any' | 'active'`); the tool-boundary access gate in `CoachingService` reads it from the registry. Gating semantics are unchanged (ADR-0011): reads of one's own data stay any-tier (`get_entry`), writes and new logging stay active-only. The crisis-safety floor stays upstream and is untouched (ADR-0030).
- **The tilt accept/decline pre-check stays upstream** in `CoachingService.handle`. It is a pending-offer state machine, entangled with crisis-floor ordering and distinct from the spoke-session floor, so it does not move into `invoke`/`resume`. Recorded here as a known asymmetry.
- `coach` is both a registered spoke (the router can pick it) and the `fallthrough` target.
- `spoke-session`'s stored spoke names widen to any registered intent; its interface (`active`/`consume`/`clear`/`setActive`) is otherwise unchanged.

## Consequences

- A new spoke = register one `Spoke`. A new tool = one `ToolSpec` plus a case in that spoke's `invoke`. The hub and the access gate do not change.
- The intent router gains a dependency on the spoke catalogue — it generates its prompt from the registry rather than from a hand-maintained list.
- This subsumes the separately-considered "uniform spoke interface behind `dispatch()`" deepening: the uniform `invoke`/`resume` interface is what the registry dispatches through.
