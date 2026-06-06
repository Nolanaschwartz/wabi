# Observability: self-hosted error tracking in-infra; uptime monitoring external; bot liveness is a safety check

Wabi splits observability by whether the signal carries personal data — the same principle as ADR-0017 (personal-data sub-processors local; non-personal externals fine):

- **Error tracking → in-infra.** Self-hosted **GlitchTip** (Sentry-compatible) runs in the project; the bot and web report exceptions, failed pg-boss jobs, failed webhooks, and failed escalations to it. Error payloads can contain personal data (message fragments, user IDs), so they stay on our infrastructure (ADR-0009), and **message content is scrubbed** before reporting (same posture as crisis-scrubbing for Langfuse, ADR-0010).
- **Uptime monitoring → external, by necessity.** The bot exposes a `/health` endpoint (gateway connected **and** Postgres reachable). An **external** monitor (UptimeRobot / Better Stack / a self-hosted Uptime Kuma on a *different* host) pings it and **alerts on disconnection**. A monitor co-located with the thing it watches dies *with* it, so the witness must live outside the infra. `/health` exposes no personal data.

## Bot liveness is a safety invariant, not an ops metric

The entire crisis safety floor (ADR-0021) only functions if the bot is **up**: a crashed or gateway-disconnected bot means a user in crisis DMs into the void — no tripwire, no resources. Therefore **downtime alerting is a launch requirement**, not a deferrable nicety. "Is the bot alive?" is the liveness check on the safety floor.

## Why

Aggregated, in-infra error tracking catches the failures that matter for a safety product (a failed escalation, a stuck job) without shipping personal data to an external SaaS. External uptime monitoring is the one place an external dependency is *correct* — it must be independent of the infra it observes — and it carries no personal data, so it does not tension ADR-0009.

## Consequences

- A `GlitchTip` container joins the deployment; SDKs in bot + web with a content-scrubbing `beforeSend`.
- The bot serves `/health` (gateway + DB); an external monitor + alert channel is configured before launch.
- Error tracking may start lean (structured logs) but GlitchTip is the chosen in-infra destination.
