# Wabi — System Architecture

A consolidated view of how Wabi v1 fits together. This is the *system design*; the
*why* behind each choice lives in `docs/adr/`, the *vocabulary* in `docs/contexts/`,
and the *task-level plan* in `docs/PLAN.md`. Where they disagree, the ADRs win.

Wabi is a **DM-first, non-clinical wellness companion for gamers** (ADR-0001/0003):
a person talks to it in their Discord DMs like a friend, and it coaches them with
memory and evidence-based strategies — with a hard crisis-safety boundary that
overrides everything.

---

## Components

### Application processes

- **`bot`** — NestJS + necord over discord.js v14 (ADR-0019). The heart of the system:
  - Discord gateway (free-form DM coaching, ADR-0015)
  - The crisis-screening + coaching pipeline
  - Stripe **webhook controller** (inbound HTTP)
  - **pg-boss worker** + scheduler (ADR-0018): session-end Memory sweeper, trial-expiry,
    crisis follow-up, check-ins, session-mining/research crons, Strategy demote
  - Must be **always-on** (persistent gateway + worker) — never serverless (ADR-0020)
- **`web`** — Next.js 15 App Router: landing, Discord OAuth (+ consent + trial + `User`
  creation), Stripe checkout, dashboard, `/admin/drafts` Strategy review. lucia sessions.
- **`shared`** — plain TypeScript: types, constants, the access resolver.

### Self-hosted data stores (ADR-0009)

| Store | Holds | Notes |
|---|---|---|
| **Postgres** (Prisma) | Records, `User`, lucia Sessions, Escalation Events, AiConversation metadata, Strategy drafts/feedback, pg-boss jobs | The only **authoritative, non-rebuildable** store |
| **Redis** | Live session buffer (`wabi:sess:<userId>`, ~10 turns) | **Ephemeral, persistence OFF** (ADR-0016) |
| **Qdrant** | `wabi_strategies` (shared) + `mem0_<userId>` (personal, via Mem0) | 768-dim (ADR-0017) |
| **Mem0** | Derived Memory; history store **disabled** | Rebuildable from Records (ADR-0004) |
| **Embeddings** | bge-base, OpenAI-compatible endpoint | **Local** — personal data never leaves infra (ADR-0017) |
| **Langfuse** | LLM traces (crisis-scrubbed) | Self-hosted; personal data under delete-my-data |
| **GlitchTip** | Application errors (content-scrubbed) | Self-hosted error tracking (ADR-0022) |

### External (egress only)

- **Discord** — identity + the DM transport (unavoidable)
- **OpenAI** — chat (coach + classifier), **PoC only**, behind the per-role swappable
  provider (ADR-0009); the destination is a local/open model
- **Stripe** — billing + email

---

## Deployment topology (ADR-0020)

```
                         Railway project (private networking)
  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                    │
  │   web (Next.js) ── public HTTPS                                    │
  │   bot (NestJS)  ── public: POST /webhook/stripe only              │
  │     │                                                              │
  │     ├── Postgres   (private)        ── pg-boss jobs live here     │
  │     ├── Redis      (private, no persistence)                      │
  │     ├── Qdrant     (private)                                      │
  │     ├── Mem0       (private) ── embeds via ↓                      │
  │     ├── embeddings (private, bge-base)                            │
  │     └── Langfuse   (private)                                      │
  └──────────────────────────────────────────────────────────────────┘
        │ outbound                       ▲ inbound (webhook only)
        ▼                                │
   Discord gateway,  OpenAI (PoC chat)   Stripe
```

Only `web` and the Stripe webhook are publicly reachable; every data store is
private-networking only. Containers keep it portable to a GCP VM later.

---

## Key flows

### 1. Onboarding (web-first; ADR-0015/0011)

```
landing → "Connect Discord" (OAuth: identify email)
  → create User + consentAcceptedAt + trialEndsAt + lucia session
  → "Start talking to Wabi" → hub-server invite link
  → user joins locked-down hub → guildMemberAdd → welcome DM
```

The DM path **never** creates a `User`; an unknown/unconsented DM gets the tripwire
plus a "finish setup" link, never coaching.

### 2. Coaching hot path (ADR-0015 + Q-decisions)

```
DM arrives (necord messageCreate)
  → crisisTripwire(text)                 ── ALWAYS, zero-dep (ADR-0021)
        └─ hit → escalate (see flow 3)
  → user lookup (no upsert)
  → consent gate / access gate           ── unconsented→setup; lapsed→resub prompt
  → debounce ~2–3s (coalesce burst)      ── (ADR / Q14)
  → ┌ classifier (fast model)  ∥  retrieval (embed → Mem0 + Strategy) ┐
    └ await classifier verdict ──────────────────────────────────────┘
        ├─ crisis → escalate, discard retrieval, no coach/store
        └─ safe   → coach(context) → sendTyping + single message
                    → append turn to Redis buffer
  ... later: pg-boss sweeper finds idle session
        → extract Memory → Mem0 → write AiConversation.topic → DEL redis key
```

Gating rule (ADR-0011): tripwire **always** · classifier **when consented (active or
lapsed)** · coach + store + new logging **active access only** · data read/export/delete
**always**.

### 3. Crisis (ADR-0006/0010/0021)

```
tripwire OR classifier fires
  → surface locale Crisis Resources (local file)
  → log Escalation Event { timestamp, layer }   ── content-free
  → CLEAR Redis buffer
  → session.doNotMine = true                     ── sweeper never derives Memory
  → schedule one gentle follow-up (durable pg-boss job)
  → re-screen every subsequent turn; resume coaching only on a clear safe pivot
  → never notify third parties; scrub from Langfuse
```

### 4. Billing / access (ADR-0005/0011)

```
web checkout (straight paid sub, no Stripe trial)
  → Stripe → bot webhook controller (idempotent)
  → handle customer.subscription.created/updated/deleted → map status
  → access resolver: hasActiveAccess = (now < trialEndsAt) OR stripeStatus ∈ {active,trialing}
```

---

## Personal-data map

| Data | Where | Lifecycle |
|---|---|---|
| Verbatim DMs | Discord (+ transient OpenAI for PoC) | Never persisted by Wabi (ADR-0013) |
| Live turns | Redis | Ephemeral, evaporate at session end |
| Records | Postgres | Authoritative; export/delete |
| Derived Memory | Mem0 → Qdrant `mem0_<userId>` | Rebuildable; deleted by dropping the namespace |
| Escalation Events | Postgres | Content-free; deletable |
| Traces | Langfuse | Crisis-scrubbed; under delete-my-data |
| Identity/email/billing | Discord, Stripe | External identity-tier (accepted) |
| Shared Strategies | Qdrant `wabi_strategies` | **Non-personal** — never deleted on user delete |

Delete-my-data = Postgres rows + Mem0 namespace + Escalation Events; **never** the
shared Strategy collection (ADR-0004).

---

## Cross-cutting posture

- **Safety over availability** (ADR-0021): zero-dependency crisis floor; screening fails
  closed (no classifier → no coaching); `crisis-resources.json` ships in the image.
- **Privacy by construction**: inner-state never on a social surface (ADR-0002); personal
  embeddings local (ADR-0017); no durable transcript (ADR-0013); locked-down hub so
  membership isn't observable (ADR-0015).
- **Swappable inference** (ADR-0009): per-role providers (`coach` / `classifier` /
  `embedding`), each independently configurable; OpenAI is PoC-only.
- **Single process for v1**: Redis + pg-boss make horizontal scale possible later;
  in-memory debounce state would move to Redis at that point.
- **Observability split** (ADR-0022): error tracking is **in-infra** (self-hosted
  GlitchTip, content-scrubbed); uptime monitoring is **external** (a witness must
  outlive the host it watches). Bot `/health` liveness is treated as a safety check —
  bot-down = crisis-unreachable.

---

## ADR index (system-shaping)

0001 non-clinical · 0002 inner-state private · 0003 DM-first · 0004 three-store +
delete · 0005 paid-only + safety carveout · 0006 layered crisis detection ·
0007 gentle gamification · 0008 sparing check-ins · 0009 self-host + swappable LLM ·
0010 crisis aftermath · 0011 trial/access lifecycle · 0012 Strategy quality gate ·
0013 no transcript store · 0014 evals = monitoring + CI gate · **0015** classic-bot +
web-first onboarding · **0016** ephemeral buffer + session-end memory · **0017**
self-hosted embeddings · **0018** durable pg-boss jobs · **0019** NestJS backend ·
**0020** deployment/ops (Railway) · **0021** graceful degradation + safety floor ·
**0022** observability + liveness
