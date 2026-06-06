# `packages/bot` is a NestJS app (necord for Discord); `packages/web` stays Next.js

The backend process — the Discord bot, the Stripe webhook, the schedulers/workers, and all AI services (coach, crisis screening, access, memory, RAG) — is a **NestJS** application. Discord integration uses **necord** (decorators over discord.js v14); the Stripe webhook is a **NestJS controller** in `packages/bot` (replacing the plan's bare Express server). `packages/web` remains **Next.js 15** (App Router) for the landing page, Discord OAuth, Stripe checkout, dashboard, and the `/admin/drafts` review surface — NestJS does not replace it.

## Why

- The backend is **service-heavy and safety-critical**. NestJS DI turns coach / crisis-screening / access-gating / memory-sweeper / Stripe / RAG into clean injectable modules, and makes the safety-critical units **trivially testable** — which directly serves the CI safety gate (ADR-0014). Hand-rolled discord.js makes mocking the classifier or access guard a chore.
- **Lifecycle hooks** (`OnApplicationShutdown`) give graceful shutdown — flush in-flight Redis sessions and close the gateway cleanly on deploy (matters given the ephemeral buffer, ADR-0016).
- A real HTTP layer for the **Stripe webhook** (proper raw-body signature verification) instead of bare Express; the webhook lives with the bot because the bot owns access state and is the only component that can DM the user about billing changes.
- `@nestjs/config` cleanly expresses the per-role provider configuration (ADR-0009 / ADR-0017).
- pg-boss, Prisma, Vercel AI SDK, the Redis client, and discord.js are framework-agnostic and drop in as providers.

## Considered options

- **Hand-rolled discord.js + Express (the plan's default)** — lower upfront boilerplate, but no DI/testability story for safety-critical services, and a custom file-walking command loader to maintain. Rejected for a backend this safety-sensitive and service-dense.
- **necord vs raw-discord.js-as-provider vs @discord-nestjs** — chose **necord** (maintained, least boilerplate, and the critical `messageCreate` pipeline stays explicit inside the handler; the decorator only routes the event).

## Consequences

- Upfront boilerplate is higher than a plain discord.js script — an accepted tax that pays back as the service count grows.
- The bot exposes an inbound HTTP port (Stripe webhook); keep its surface minimal and verify signatures.
- Slash commands and gateway events are registered via necord decorators; the crisis-first ordering remains explicit application code, not framework magic.
