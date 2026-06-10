# Every free-text inner-state field crosses Crisis Screening before it persists

**Crisis Screening** — the tripwire then the contextual classifier (ADR-0006) — must run over **any field where a person types prose about how they feel**, before that field is stored or rewarded. This is a property of the *field* (free text about inner state), not of the command or surface. The free-form DM path, a **Journal Entry**, a **Mood** note, and a **Tilt Session** trigger all cross the same screening; on a crisis hit each performs a **Crisis Escalation** (surface locale **Crisis Resources** + record one content-free **Escalation Event**), the field is not persisted, and it earns no XP / Engagement.

A field-surfaced crisis escalates resources + Escalation Event but **not** the DM-session **Crisis Aftermath** (quarantine + follow-up): a logged field is not a **Conversation**.

## Why

A false negative in crisis detection is irreversible (ADR-0006's asymmetric error bias). The gap was real and concrete: a person could type "I don't want to be alive" into `/mood log note:` and receive a logged mood, a cheerful trend, and "Thanks for checking in" — no tripwire, no classifier, no resources, no event. Only `/journal` screened at all, and even it returned a generic platitude rather than real resources or a logged event.

The obligation must live at **one shared screened-record path**, not be re-derived per surface. The proof that per-surface screening fails is that it already had: of three free-text inner-state fields, two (Mood note, Tilt trigger) were entirely unscreened and one (Journal) was screened weakly. A shared path means a newly-added free-text field cannot silently skip screening.

Screening is **unconditional** — independent of consent and Active Access, exactly like the DM tripwire (ADR-0011: crisis is not an Entitlement; ADR-0026: inner-state logging is not access-gated). Adding screening does not gate these commands; it adds the safety layer beneath them.

## Corrects ADR-0026

ADR-0026 stated that "the structured commands (`/mood`, `/tilt`, `/playtime`) take no free-text body, so they present no crisis surface." That is factually wrong: `/mood log` has an optional `note` and `/tilt start` has an optional `trigger`, both free text. ADR-0026's access-gating decision is unaffected (screening is orthogonal to access), but its crisis-surface claim is superseded here.

## Scope and bounds

- **Full screening** (tripwire + classifier) applies to free-text fields that invite or accept expression of inner state: Mood note, Tilt trigger, Journal Entry, and the DM path.
- **Structured fields present no crisis surface** and are not screened: a Mood rating, Tilt severity, Playtime duration. Playtime's `game` label is a structured name, not an inner-state field; the zero-cost tripwire may run on any free text as defence-in-depth, but the classifier is reserved for inner-state prose.
- **Escalation is decoupled from the transport.** The escalation core (`escalate(userId, layer) → resources payload + Escalation Event`) takes a `userId`, not a `discord.js` `Message`, so every surface renders the returned resources on its own reply channel.

## Consequences

- A single `CrisisScreening.screen(userId, content)` is the entry every atomic free-text surface calls before persisting; the DM path runs the two layers around burst-coalescing but routes hits through the same escalation seam.
- The contextual classifier is a crisis-detection layer and lives in the crisis module alongside the tripwire (not in coaching).
- A future free-text field that skips the shared screened-record path is a safety regression, not a stylistic choice.
