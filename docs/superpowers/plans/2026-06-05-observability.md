# Observability: GlitchTip + /health + uptime alert

Date: 2026-06-05
Issue: `.scratch/v1-coaching-companion/issues/06-observability-and-liveness.md`
Status: draft

## Scope

1. Self-hosted GlitchTip in docker-compose
2. Sentry SDK in bot + web with content-scrubbing `beforeSend`
3. `/health` endpoint: Discord gateway + Postgres checks
4. External uptime monitor configuration (UptimeRobot, free tier)

## Tasks

### Task 1 — Add GlitchTip to docker-compose.yml
- Add `glitchtip` service with postgres dependency, port 8000
- Add required env vars: `GLITCHTIP_SECRET_KEY`, `GLITCHTIP_DB_NAME`, `GLITCHTIP_ALLOWED_HOSTS`
- Create dedicated `glitchtip_data` volume

### Task 2 — Add Sentry SDK to bot package
- Install `@sentry/node` in bot
- Add `@sentry/integrations` for `RewriteFrames`
- Create `@/lib/sentry.ts` with:
  - `init()` called in `main.ts`
  - `beforeSend` that scrubs `message` (replace with `[redacted]`), `extra.data`, stack trace params
  - DSN points to `http://glitchtip:8000/1`
- Export as workspace module from `@wabi/shared` for reuse

### Task 3 — Add Sentry SDK to web package
- Install `@sentry/nextjs` in web
- Configure `sentry.config.js` or `sentry.edge.config.ts` with same scrubbing logic
- DSN points to `http://glitchtip:8000/1`

### Task 4 — Health endpoint
- Create `HealthModule` + `HealthController` in bot
- `GET /health` returns `{ status: 'ok' | 'degraded', checks: { gateway: bool, db: bool } }`
- Gateway check: `client.isReady()` on Discord Client
- DB check: `prisma.$queryRaw` or `prisma.$connect` probe
- 200 only if all checks pass; 503 if degraded

### Task 5 — External uptime monitor
- Document UptimeRobot setup (manual step):
  - Monitor URL: `https://wabi.example.com/health`
  - Alert channel: email + webhook
- Add `HEALTH_URL` to `.env.example`

### Task 6 — Tests
- Unit test: `/health` returns 200 when gateway + DB healthy
- Unit test: `/health` returns 503 when DB down
- Unit test: `/health` returns 503 when gateway not ready
- Smoke test: simulated disconnect triggers GlitchTip error capture

## Files created/modified

| File | Action |
|------|--------|
| `docker-compose.yml` | Add GlitchTip service |
| `packages/bot/src/main.ts` | Add Sentry init |
| `packages/bot/src/modules/health/health.module.ts` | Create |
| `packages/bot/src/modules/health/health.controller.ts` | Create |
| `packages/bot/src/modules/health/__tests__/health.controller.spec.ts` | Create |
| `packages/shared/src/sentry.ts` | Create |
| `packages/web/sentry.config.js` | Create |
| `packages/web/src/lib/sentry.ts` | Create |
| `.env.example` | Add GlitchTip env vars |

## Dependencies

- Blocked by: #01 Skeleton (done)
- Blocks: #07 (coaching turn — needs error tracking), #10 (billing — needs health check)
