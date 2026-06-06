# Downtime Alerting Setup

## Health Endpoint

The bot exposes `/health` which checks gateway and database status:

- `200` — all checks pass
- `503` — gateway or database unhealthy

## External Monitor Setup (Operator Action Required)

### Option A: Healthchecks.io (Recommended)

1. Create account at https://healthchecks.io
2. Create new check with:
   - URL: `https://your-wabi-instance.com/health`
   - Method: GET
   - Interval: 5 minutes
   - Timeout: 1 minute
3. Configure alert channel (email, Slack, PagerDuty, etc.)
4. Store webhook URL in `.env` as `HEALTHCHECKS_IO_SECRET` if using push method

### Option B: Uptime Kuma (Self-hosted)

Add to `docker-compose.yml`:

```yaml
uptime-kuma:
  image: louislam/uptime-kuma:1
  ports:
    - '3002:3001'
  volumes:
    - uptime_kuma_data:/app/data
  restart: unless-stopped
```

Then:
1. Open http://localhost:3002
2. Add monitor:
   - Type: HTTP(s)
   - URL: `http://bot:3000/health` (internal) or `https://your-wabi-instance.com/health` (external)
   - Interval: 60 seconds
3. Configure notification (email, Slack, etc.)

### Option C: Simple Cron (Minimal)

```bash
*/5 * * * * curl -sf https://your-wabi-instance.com/health || echo "Wabi down" | mail -s "Wabi Alert" ops@example.com
```

## Railway Deployment

Railway has built-in health checks:
1. Go to your project → Settings → Health Check
2. Set endpoint: `/health`
3. Configure alert notifications in Railway dashboard

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HEALTHCHECKS_IO_SECRET` | No | Webhook secret for healthchecks.io push method |

## Volumes

Add to docker-compose if using Uptime Kuma:
```yaml
volumes:
  uptime_kuma_data:
```
