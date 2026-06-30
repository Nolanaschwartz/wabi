# An onboarding-incomplete User is gated like a pre-setup User; the nuanced crisis classifier unlocks at onboarding-completion, not consent

A consented User whose **Onboarding** is incomplete (`onboardingCompletedAt` null — they accepted consent and got a Trial but never finished **Personalization**) is gated in the coaching pipeline **at the consent tier**: the gate fires immediately after the consent check and **before** the `classify ∥ strategy ∥ prepare` block, replying with a "finish setup on the web app" nudge. The always-on **tripwire** (the zero-dependency crisis floor, ADR-0021/0030) still runs upstream of routing, but the **crisis classifier does not run** for these Users. Net effect: the nuanced crisis-detection layer (ADR-0006) effectively unlocks at **onboarding-completion**, not at consent.

This **amends ADR-0011's gating model**, whose line `classifier -> when consented` would, read literally, run the classifier for a consented-but-un-onboarded User. "Consented" in that rule is hereby read as "consented **and** onboarding-complete" for the purpose of unlocking the classifier.

## Why

An un-onboarded User is treated as **not yet a real coaching user** — the same stance the system already takes toward an unconsented DM, which gets the tripwire floor and a setup link and nothing else (ADR-0015). Onboarding-incomplete is just the second beat of that same "not set up yet" state: the person has a row and a Trial, but has given Wabi nothing to coach *with*, and the product's contract is web-first setup before coaching. Gating early — before the classifier and the coaching prep — keeps the un-onboarded path cheap and structurally identical to the unconsented path: one tier, one nudge, no inference.

The deliberate cost is a **bounded crisis-screening gap**: a person who consented, abandoned Personalization, then DMs the bot and expresses crisis in a way the regex tripwire misses but the classifier would catch, receives the onboarding nudge instead of resources. This was chosen with eyes open. The window is narrow and transient — the web flow routes straight from consent to `/onboarding`, so reaching this state requires bailing mid-setup and then DMing — and explicit crisis language still escalates via the always-on tripwire. The safety floor (ADR-0021) is never removed; only the nuanced second layer is deferred to the moment the person actually becomes a coaching user.

## Considered alternatives

- **Run tripwire + classifier first, then short-circuit to the nudge before the coaching work ("A′").** Closes the gap for ~one classifier call per message from an un-onboarded User. Rejected: it makes the un-onboarded path structurally unlike the unconsented path (a partial pipeline that screens-then-refuses), to protect a narrow, transient, tripwire-covered window. The owners chose the simpler single-tier gate.
- **Gate at the coach tier beside the Active Access check (full screening, withhold only coaching).** Same safety as A′, same rejection reason, plus it wastes a strategy fetch per message.

## Consequences

- The onboarding signal rides `AccessResolver.resolveAccount` — already a whole-`User` read for `decideAccess` (ADR-0011), so exposing `onboardingCompleted` adds no query.
- The gate lives in `coaching.service` at the consent tier, a sibling of the unconsented → `setupLinkMessage` branch, sending a new `finishOnboardingMessage`. The welcome opener stays consent-only (it does not also nudge un-onboarded Users).
- This is a **bot coaching gate only**. The web dashboard never hard-gates on onboarding: billing and Data Rights stay always-available (ADR-0011/0004), and Personalization is a nudge there, not a wall.
- If the un-onboarded population ever stops being transient (e.g. a flow that lets people linger consented-but-un-onboarded), revisit: the cost calculus that justified deferring the classifier assumes the window stays short.
