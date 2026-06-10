# Inner-state log commands (`/mood`, `/journal`, `/tilt`, `/playtime`) are not access-gated; ADR-0011's "new logging" gate is scoped to the coaching pipeline

Logging one's own inner state through a slash command — `/mood log`, `/journal write`, `/tilt …`, `/playtime log`, and the XP/streak side effects they trigger — runs **without** an Active Access check and **without** a consent check at the write site. Only the **coaching pipeline** (the free-form DM path in `coaching.service.ts`) gates on consent + Active Access. This is deliberate.

This **amends the four-line rule in ADR-0011**, whose line `coach + store + new logging -> ACTIVE ACCESS only` would, read literally, gate these commands. "New logging" in that rule is hereby scoped to mean **logging derived from a coaching turn** (memory/session writes inside the DM pipeline), **not** the standalone inner-state log commands.

## Why

Logging your own mood or journal entry is closer to **exercising a data right** (ADR-0004/0011: "your existing data and your rights" are never gated) than to consuming **new AI work** (the thing ADR-0005/0011 charges for). The expensive, gated resource is inference — the coach. A `/mood log` write is a cheap Postgres insert the person makes *about themselves*; putting it behind the paywall would weaponise a person's own self-tracking as conversion pressure, the exact failure ADR-0011 exists to prevent. Keeping these commands free also lets a person build the logging habit during and after the trial, which is the behaviour the product wants to reward, not ration.

The coaching DM path stays gated because that is where the unbounded inference cost lives.

## Scope and bounds

- **Still gated (unchanged):** free-form coaching DMs, proactive check-ins, and any memory/session derivation inside the coaching pipeline — all require consent + Active Access (ADR-0011/0015).
- **Crisis safety is unaffected.** `/journal write` is free-text, so `JournalService.write` runs the classifier and short-circuits to the crisis response on a crisis classification (no entry persisted, no XP). The structured commands (`/mood`, `/tilt`, `/playtime`) take no free-text body, so they present no crisis surface. The DM tripwire is untouched.
- **The DM path still never creates a `User`** (ADR-0015). These commands operate on whatever `User`/identity already exists; they do not onboard anyone.

## Open question (not decided here)

Whether an inner-state write should require **consent** (a `consentAcceptedAt` user) even though it does not require Active Access. Writing inner-state data for a wholly un-consented identity has privacy weight (ADR-0002/0017). Today these commands perform no consent check. If product/legal decides consent must precede any inner-state persist, that is a **consent gate** (a narrower change than access-gating) and should be recorded as a follow-up amendment to this ADR — not as a reason to access-gate the commands.

## Consequences

- The inner-state log command handlers (`mood`, `journal`, `tilt`, `playtime`, and the `xp`/`streaks` writes they drive) intentionally carry **no** `accessResolver.resolve` / `hasActiveAccess` call. This is the sanctioned state, not an oversight — a future architecture review should not "fix" it by adding a gate without revisiting this ADR.
- ADR-0011's four-line rule should be read with this scoping: its `new logging` clause covers coaching-pipeline writes, not standalone log commands.
- If the open consent question is resolved as "consent required," only a consent check is added at those write sites; the no-access-gate decision stands.

## Amendment (2026-06-09)

The claim in *Scope and bounds* that "the structured commands (`/mood`, `/tilt`, `/playtime`) take no free-text body, so they present no crisis surface" is **incorrect**: `/mood log` has an optional `note` and `/tilt start` an optional `trigger`, both free text and both previously unscreened. Crisis Screening of **all** free-text inner-state fields is now required by **ADR-0028**, and the `/journal` crisis response is upgraded there from a generic platitude to real resources + an Escalation Event. This does **not** change the access-gating decision recorded here — screening is unconditional and orthogonal to Active Access.
