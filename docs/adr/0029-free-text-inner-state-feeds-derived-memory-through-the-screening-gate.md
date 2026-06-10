# Free-text inner-state feeds derived Memory through the same gate that screens it

The three free-text inner-state fields — a **Journal Entry**, a **Mood** note, a **Tilt Session** trigger — feed **derived Memory** (Mem0 → Qdrant vectors + the neo4j graph, ADR-0025) on the **success path of the same Crisis Screening guard that already governs them** (ADR-0028). The set of fields that derive Memory is *exactly* the set that crosses screening: free-text expression of inner state, and nothing else.

Structured inner-state **metrics** — a Mood rating, a Tilt severity, a Playtime duration, an XP amount — do **not** feed Mem0. They stay in Postgres and the coach reads them directly as a time-series ("mood trend, last 14 days"). The graph is for *relationships between facts a person reveals* (ADR-0025), not for bare numbers.

## Why

Wabi's premise is memory-driven coaching, yet the most reliable inner-state signal a person produces — the deliberate, timestamped, already-screened log — was invisible to the system meant to use it. Today only conversational turns reach the graph; Journal / Mood note / Tilt trigger are Postgres-only. ADR-0025's own justifying example — *"lost his job → tilts more in ranked since → skips sleep on weeknights"* — is a graph spanning a **life event**, **Tilt**, and **Playtime**, none of which the graph can currently see from the logs. Someone journals "isolated since the move," then gets coached two days later with zero memory of it.

The fix is **not** "mine every table." It is a split by *shape*:

- **Narrative free text → Mem0.** An extraction LLM finds the relationships a graph wants. This is what Mem0 is deep at.
- **Structured metrics → Postgres, queried directly.** A rating of `3` is a point on a series, not a fact-with-relationships. Feeding it through an extraction LLM is shallow and noisy. Two retrieval mechanisms, each deep at one job.

The set of mineable fields lining up with the screened set is not a coincidence: a field is safe to derive Memory from *because* it is free-text inner state, and it is screened *because* it is free-text inner state. So **one rule** — "free-text inner state goes through `CrisisScreening.guard()`" — yields three guarantees at one seam: crisis safety, Memory derivation, and the crisis-never-mined invariant. On a crisis hit the guard neither persists nor derives, so **crisis content can never reach the graph** (ADR-0021/0010/0025) without any separate `doNotMine` plumbing for these fields. A new free-text field added behind the same guard inherits all three for free (**locality**).

## Consent — off by default

Derivation of inner-state free text is **consent-gated and off until there is an explicit user-facing expectation that journaling and notes inform coaching Memory.** The architecture being cheap (one `deriveAndStore` call on an existing seam) is not a reason to enable it silently. Journaling's value is often the unjudged private space; a wellness product that repackages "last week you wrote you felt worthless" into a coaching nudge the person never agreed to reads as surveillance and erodes the trust the product depends on (the same trust ADR-0002 protects). The trigger to enable is consent, not feasibility. The consent surface (global vs. per-entry opt-in, and how it is worded) is the product question carried in the PRD; this ADR fixes only that it **must** exist and default off.

## Relationship to existing ADRs

- **Extends ADR-0028.** ADR-0028 made `guard()` the single gate for *persist + reward* of free-text inner state. This ADR adds *derive Memory* to the same success path. The gate's field set is unchanged; only its consequence grows.
- **Refines ADR-0002, does not break it.** ADR-0002 keeps inner state out of the **Community** context. Derived Memory lives in the per-user `mem0_<userId>` namespace and is consumed only by that person's own DM coaching — a **Wellbeing** surface, never a social one. "Private to the Wellbeing context and to that person" *includes* that person's own coaching Memory; it does not mean "never leaves Postgres." See the amendment on ADR-0002.
- **Operationalizes ADR-0025.** It names which non-conversational inputs feed the hybrid store, and keeps the bot talking only to Mem0 — no direct neo4j path is introduced.

## Scope and bounds

- **Feeds Mem0:** Journal Entry `content`, Mood `note` (and `context`), Tilt Session `trigger` — on the guard's success path only.
- **Stays in Postgres, never Mem0:** Mood `rating`, Tilt `severity`, Playtime `duration`, XP, and every account/billing/strategy field. The coach queries these directly.
- **Never derived:** an **Escalation Event** (content-free by design, ADR-0021) and any crisis-tripping field (blocked by the guard).
- **PlaytimeLog is the documented exception to "screened ⟺ mineable":** a long session already mines a *synthesized sentence* ("Long play session: N minutes of X"), and it is *not* screened because it carries no free text to screen. This is behavioral context, defensible, and called out here so a future explorer does not read it as a bug.
- **A periodic rollup digest is out of scope** — having the graph learn "mood declined two weeks straight" is a synthesis job that writes one derived sentence, *not* per-row mining of `rating`. Future work, named so it is not conflated with this decision.

## Consequences

- `JournalService.write()` / the Mood-note and Tilt-trigger write paths call `MemoryStore.deriveAndStore()` **inside** the `guard()` success closure, behind the consent flag.
- **Erasure must cascade to the graph.** Mem0's per-user vectors are already purged on a data-rights delete (ADR-0004 amendment); this decision makes it a **hard requirement** that the same delete-by-`user_id` also purges the neo4j graph, not just Qdrant — otherwise journal-derived nodes survive an erasure request. The ADR-0011 completeness test introspects Prisma models only and is blind to Mem0's graph, so this must be verified out-of-band (an integration assertion against Mem0, not a DMMF check).
  - *Implementation status (2026-06-09):* the bot already satisfies the requirement structurally — `DataRightsService.delete` issues `DELETE /memories?user_id=mem0_<userId>`, which Mem0's `delete_all` cascades to both Qdrant and the configured neo4j graph_store. The bot holds **no direct neo4j client**, so there is nothing to add to the deletion path. The out-of-band *verification* is **deferred**: a faithful test must seed a real graph node via `deriveAndStore`, which needs Mem0's extraction LLM + embedder (the privately-managed inference endpoints), so it cannot run hermetically in CI. When a live mem0+neo4j integration rig exists, gate the assertion to run only where inference is reachable. See `.scratch/inner-state-memory-derivation/issues/04-erasure-cascades-to-neo4j.md`.
- The structured-metrics-stay-in-Postgres rule is explicit: a future change that pipes a rating or severity into Mem0 is a regression against this ADR, not a tuning choice.
