# Deferred and recurring jobs run on Postgres (pg-boss), not in-process timers or Redis

All deferred and recurring work runs through **pg-boss**, a durable job queue backed by the **Postgres** we already operate. This replaces the plan's scattered `setInterval`/`setTimeout` and is deliberately **not** built on the Redis added in ADR-0016 — that Redis runs with persistence **off** (ephemeral session buffer), so it cannot be a durable job store.

Jobs that become pg-boss jobs: the session-end **Memory sweeper** (ADR-0016), **trial-expiry** reconciliation (ADR-0011), the **one gentle crisis follow-up** (ADR-0010), tilt-session auto-resolve, check-in scheduling, session-mining (nightly), research-cron (monthly), and Strategy demote/quarantine (ADR-0012).

## Why

- **Safety/correctness jobs must survive restarts.** The crisis follow-up and tilt auto-resolve are in-memory `setTimeout`s in the plan — a deploy or crash silently drops them. Dropping a crisis follow-up is a lost safety promise (ADR-0010). Durable jobs fix this.
- **Postgres, not a second Redis.** The obvious "we already have Redis → BullMQ" path collides with ADR-0016's persistence-off Redis (queued jobs would vanish on restart). Rather than run a *second*, persistent Redis just for jobs, use the durable store already present: Postgres. No new infrastructure; Redis stays purely ephemeral.

## Consequences

- pg-boss owns its own tables in Postgres; the worker runs in the bot process (or a dedicated worker later).
- Redis is exclusively the ephemeral session buffer (ADR-0016); it never holds a job that must survive a restart.
- Recurring jobs are defined declaratively (cron-style) rather than as drifting `setInterval`s.
