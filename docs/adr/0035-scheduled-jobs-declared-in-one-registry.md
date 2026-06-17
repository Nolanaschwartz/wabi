# Scheduled jobs are declared in one registry, drained by the Scheduler at bootstrap

Every pg-boss job in the bot is declared once into a shared `JobRegistry` (`packages/bot/src/modules/scheduler/`), keyed by a `Job` enum that is the single source of its queue name. Owning services `declare(...)` their job from `onModuleInit`; `SchedulerModule` drains the registry in `onApplicationBootstrap` and binds each one, recording the per-job outcome on `SchedulerService.jobStatus`, which `/health` surfaces.

This **replaces** the prior pattern where each of five modules called `scheduler.cron`/`work` directly with its own queue string — two as raw literals (`'crisis-follow-up'`, `'check-in-scheduler'`), the rest as per-module consts — and a failed registration vanished into a best-effort `catch {}`.

## Why

The `SchedulerService` consolidation (one pg-boss client, one pool, one lifecycle) was already deep. What stayed shallow was the **job set**: it had no seam. Three frictions followed.

- **Producer/consumer queue-name drift.** A job's name lived in the owner's registration *and* again at every `send`/`sendAfter` enqueue site. `strategy-demote` and `crisis-follow-up` each had a producer and a consumer that had to agree on a string by convention. The `Job` enum makes the name one importable value crossing both sites, so they cannot diverge.

- **Silent registration failure.** `scheduler.work`/`cron` swallowed bind errors (`catch {}`) so the client could fail open and the bot still boot (ADR-0019/0021). Correct for degradation, but it also hid a *real* failure: a single job that threw on `createQueue` left no trace. `drainRegistry` keeps fail-open (degraded client ⇒ every job marked `degraded`, nothing binds) while separating it from `failed` (client up, bind threw) and surfacing both on `/health`. One bad worker no longer sinks the others, and an operator can see which.

- **No legible job set.** Nowhere listed what runs on the scheduler. The registry is that list, and a completeness test asserts every `Job` is declared exactly once at boot — the same discipline the data-rights `sources[]` list uses to guarantee no store is forgotten.

## Scope and bounds

- The registry is **payload-agnostic**. Enqueue payloads (`{draftId}`, `{userId,message}`) stay typed inside the owning module, where producer and handler already sit together — there was no cross-seam gain in threading payload generics through the registry.
- Handlers are instance-bound (they close over their service), so a job is declared from the owner's `onModuleInit`, not from a static table. The registry holds the declarations; the Scheduler owns the binding.
- The drain runs at `onApplicationBootstrap` (after every `onModuleInit`), so registration no longer depends on module init order. This is a **centralisation, not a bug fix**: all five owners already imported `SchedulerModule`, so Nest's "imported module inits first" guarantee already ordered them. The move removes the reliance on that implicit rule, not a live race.
- A failed job registration does **not** flip `/health` to 503. The bot is still serving DMs; a 503 would only bounce the process without fixing the bind. The job buckets are surfaced for an operator, not used to gate liveness.

## Consequences

- Adding a scheduled job is: add a `Job` member, `declare` it from the owning service. The completeness test fails until both halves exist, so a forgotten registration is caught at test time, not in production silence.
- `/health` now carries `jobs: { registered, degraded, failed }`. Anything consuming the health body should treat the new field as additive.
- A future review will see `SchedulerService` bridging many modules and may read it as a god-module. That breadth is the shared-client seam (ADR-trace: the five-pools consolidation) plus this registry — both deliberate. The jobs it carries are now enumerable in one place rather than scattered, which is the point.
