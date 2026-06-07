# Downtime Alerting Setup

Bot-down means the crisis safety floor is unreachable (ADR-0021), so downtime alerting is a
**launch gate**, not a nicety (ADR-0022). The `/health` endpoint exposes no personal data, so the
witness can live anywhere.

## The one rule (ADR-0022)

**The monitor must live in a different failure domain than the bot.** A watcher co-located with
the thing it watches dies *with* it — exactly when you need the page. So:

- ✅ A separate Railway **service/project** from the bot, or a different host/region, or a hosted check.
- ❌ Adding the monitor to the bot's own `docker-compose.yml` / the bot's service.
- ⚠️ Railway's built-in Health Check (Settings → Health Check) only **restarts** the container; it
  is *not* the downtime alert and dies with the platform/project. Keep it for auto-restart, but it
  does **not** satisfy this gate on its own.

## Health endpoint

The bot serves `GET /health` (checks Discord gateway **and** Postgres):

- `200` — all checks pass
- `503` — gateway or database unhealthy

Point any monitor at `https://<your-bot>.up.railway.app/health` (the public URL of the bot service).

## Chosen setup: self-hosted Uptime Kuma on Railway (separate service)

Deploy Kuma as its **own Railway service** — ideally a **separate Railway project** from the bot so
a project-level outage doesn't take both down.

1. In Railway: **New → Deploy a Docker Image** → `louislam/uptime-kuma:1`.
2. Attach a **Volume** mounted at `/app/data` (Kuma stores its config/history there).
3. Expose it (generate a domain) and open the Kuma UI; create the admin account.
4. **Add Monitor**: Type `HTTP(s)`, URL `https://<your-bot>.up.railway.app/health`, interval `60s`,
   "Accepted Status Codes" `200` (so a `503` from `/health` trips the alert).
5. **Add Notification** (Settings → Notifications) and attach it to the monitor — email, Slack,
   Telegram, Discord webhook, or a phone/SMS provider. Credentials are operator-supplied.

For a non-Railway separate host, a ready compose file is at
[`monitoring/docker-compose.uptime-kuma.yml`](../monitoring/docker-compose.uptime-kuma.yml) — run it
on a box that is **not** part of the Wabi stack.

### Residual risk + recommended backstop

Kuma on Railway, even in a separate project, still shares Railway (and possibly a region) with the
bot. A Railway-wide or region outage takes the watcher down too. Add one **truly independent**
dead-man's-switch as a backstop:

- **Healthchecks.io** (free): create a check, set Schedule to expect a ping every 5 min, and have a
  tiny external scheduler (GitHub Actions cron, a personal box, etc.) `curl` the bot `/health` and
  ping Healthchecks only on `200`. If pings stop (bot down *or* the pinger down), Healthchecks pages
  you. This witness lives entirely outside Railway.

## Alternatives (if you change your mind)

| Option | Independence | Effort | Alerting |
|--------|--------------|--------|----------|
| Healthchecks.io (hosted dead-man's-switch) | Full (off-infra) | Lowest | email/Slack/PagerDuty |
| Better Stack / UptimeRobot (hosted poller) | Full (off-infra) | Low | email/SMS/phone/Slack |
| Uptime Kuma on a separate **non-Railway** host | Full (off-infra) | Medium | many channels |
| Uptime Kuma on a separate **Railway** service | Partial (shares Railway) | Medium | many channels |

## Operator checklist (HITL — remaining)

- [ ] Deploy the Kuma service (separate Railway project) with a persistent volume
- [ ] Configure the `/health` monitor (60s, accept only `200`)
- [ ] Configure + attach an alert channel with operator credentials and verify a test alert fires
- [ ] Stand up the external Healthchecks.io backstop (recommended)
- [ ] Confirm reproducibility (documented above) so the Railway deploy can be rebuilt
