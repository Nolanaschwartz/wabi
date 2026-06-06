# Deployment: Railway, all services as containers; minimal public surface; no formal backups in v1

Wabi v1 deploys to **Railway** as a set of containers in one project: `bot` (NestJS, persistent), `web` (Next.js), and the self-hosted data stores (Postgres, Redis, Qdrant, Mem0, embeddings, Langfuse), wired over Railway **private networking**. Containers keep the deployment **portable** — the same images move to a GCP Compute Engine VM (docker-compose) later if cost or scale demands.

## Persistent bot, not serverless

The `bot` holds a long-lived Discord gateway connection and runs the pg-boss worker (ADR-0018), so it must be an **always-on service** — it cannot run on Cloud Run / Cloud Functions / any scale-to-zero platform. `web` could be serverless, but is kept on Railway with the rest for one trust boundary.

## Network boundary

- **Public:** `web` (HTTPS) and the **Stripe webhook** endpoint (must be reachable by Stripe).
- **Private only:** Postgres, Redis, Qdrant, Mem0, embeddings, Langfuse — never publicly exposed.
- The bot's Discord gateway and LLM/Stripe calls are **outbound**.

## Self-hosting posture (ADR-0009)

Running our own Postgres/Qdrant/Mem0/embeddings/Langfuse *containers* on Railway satisfies ADR-0009 — these are our containers, not a third-party data SaaS (Mem0 cloud, Pinecone, Langfuse cloud). Railway is an **infrastructure processor** (like any VPS host); cover it with a DPA. This is the same reason GCP **Cloud SQL** was rejected — a managed data service is a step away from the self-hosting posture.

## Secrets

Railway env / shared variables for v1 (`.env` is gitignored). A dedicated secrets manager (Infisical / Doppler / GCP Secret Manager) is a later nicety, not a v1 requirement.

## Backups — none in v1 (conscious tradeoff)

v1 runs **no formal backups**. Only **Postgres** is authoritative and non-rebuildable (Mem0 rebuilds from Records per ADR-0004; Qdrant Strategies re-seed from source; Redis is ephemeral per ADR-0016), so a Postgres loss would take the system of record (Records, billing linkage, sessions) with it.

- **Accepted** for a low-volume PoC to move fast.
- **Revisit before real users / the launch gate** — the severity changes sharply once paying users have mood/tilt history.
- **Cheap upgrade path:** enable Railway managed-Postgres platform backups / PITR (paid plans) — near-zero effort when the trigger hits.
- **GDPR note for when backups land:** delete-my-data is immediate in live stores and propagates through backups within a documented retention window; a restore must re-apply pending deletes.

## Consequences

- ~8 always-on services on Railway is a real recurring cost to monitor.
- Local dev stays docker-compose (ADR-0009 local-LLM posture unchanged).
- Portability to a GCP VM is preserved by keeping everything containerized.
