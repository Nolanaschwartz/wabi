# Crisis detection is layered, context-aware, and biased toward escalation

Crisis detection is the mechanism behind the ADR-0001 safety boundary. It is **not** keyword-only — in a gaming context, pure keyword matching both misses paraphrased ideation ("I don't want to wake up tomorrow") and over-fires on harmless gamer slang ("kys", "this boss wants me dead"), which erodes trust until the safety net is muted or ignored. It works in two layers:

- **Tripwire** — a cheap, always-on keyword/regex backstop for the most explicit phrases. Runs even for users without Active Access (ADR-0005), so detection never depends on an LLM call succeeding or on the person being in an active coaching turn.
- **Contextual classifier** — during coaching, the LLM classifies crisis-vs-hyperbole using conversation context, distinguishing genuine ideation from gaming exaggeration.

**Error bias is deliberately asymmetric:** a false positive (offering resources unnecessarily) costs a moment of friction; a false negative (missing real ideation) is irreversible. On uncertainty, **escalate**.

**Escalation is a defined action, not just a flag:** stop coaching, surface locale-appropriate crisis hotlines (derived from Discord locale), hand off with a calm message, and never attempt to counsel.

## Consequences

- Requires a maintained, locale-keyed directory of crisis resources (hotlines), not just US 988.
- The classifier must be explicitly gamer-slang-aware, or precision collapses.
- Tripwire logic lives outside the entitlement gate so it can fire for lapsed/unsubscribed users.

## Amendment (2026-06-06, post-implementation)

DM crisis resources default to `en-US` because `discord.js`'s `User` type does not expose `locale` in DMs — only `GuildMember` does. This is acceptable: the international fallback (ADR-0023) is the safety guarantee for unserved locales, and US-first is the v1 scope. If locale-aware DM resources are needed later, Discord's Gateway `READY` event includes `user_settings` with locale, but that requires a privileged intent.
