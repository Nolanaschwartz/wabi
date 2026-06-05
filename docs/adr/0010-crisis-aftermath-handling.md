# Crisis aftermath: no third-party notification, minimal logging, gentle follow-up

What happens *after* Crisis Escalation (ADR-0001, ADR-0006) fires:

## Never notify third parties (default)

Wabi does **not** contact server moderators, emergency contacts, or authorities. It surfaces crisis resources to the person and lets *them* choose to reach out. Any future "alert a trusted contact" capability must be strictly opt-in, pre-registered, and separate — it is never the default. This keeps Wabi non-clinical and avoids endangering people with unwanted interventions.

## Record the event, not the content

Wabi logs only that an **Escalation Event** occurred — a timestamp and which layer fired (tripwire vs. classifier) — **not** the raw crisis message. This lets the safety system be tuned (e.g. catch a misfiring tripwire) without building a durable record of someone's ideation. Escalation Events are personal data under the delete-my-data path (ADR-0004). Crisis turns are excluded or scrubbed from Langfuse traces, which would otherwise capture the raw content (ADR-0009).

## One gentle follow-up

Wabi may send a single, opt-out, caring follow-up later (re-surfacing resources) — never repeated nagging (ADR-0008 spirit).

## Why

A non-clinical companion that handles crisis signals must be maximally protective of trust and minimally retentive of the most sensitive data. Recording *that* escalation happened, but not *what was said*, balances safety-system improvement against the harm of storing an ideation history.
