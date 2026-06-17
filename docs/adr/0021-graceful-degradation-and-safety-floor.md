# Graceful degradation: a zero-dependency safety floor, and fail-safe on screening

Wabi degrades along a single principle: **the crisis tripwire → resources path must run on zero dependencies, the coach degrades gracefully as enrichment services fail, and the system fails SAFE on screening — no classifier, no coaching.**

## The safety floor (zero dependencies)

The crisis **tripwire** is in-process keyword/regex matching, and **Crisis Resources** are a **hardcoded `RESOURCES` const in `crisis-resources.service.ts`**, compiled into the bot image. So the tripwire → surface-resources path works even if Postgres, Redis, Mem0, Qdrant, embeddings, *and* the chat LLM are all down. Escalation-Event *logging* may be deferred/lost if Postgres is down, but **surfacing resources never is**. Safety has no runtime dependency.

## Graceful coach degradation (non-fatal)

- **Mem0 / Qdrant / embeddings down** → coach proceeds without personalization/Strategies (buffer only).
- **Redis down** → contextless per-message coaching (no within-session continuity).
- **Coach LLM down** → graceful "having trouble, try again."

None of these block the coach beyond their own feature; the conversation still functions, just less enriched.

## Fail-safe on screening (the hard line)

If the **classifier** (LLM) is unavailable, Wabi **does not coach** — a paraphrased crisis with no keyword could otherwise slip through unscreened, the exact failure ADR-0006 exists to prevent. Instead: the tripwire still runs (explicit signals caught), and the reply is a gentle "I can't respond properly right now" plus a resources reminder. The **screen-before-coach invariant is absolute**: no screen → no coach.

## Likewise, no consent → no coach

If Postgres is down, consent/access can't be verified, so coaching is withheld (the consent gate fails closed, ADR-0009/0015) — but the tripwire → resources path still fires.

## Why

A mental-health companion must keep its one hard promise (surface help in a crisis) under *any* partial outage, and must never trade that promise for availability. Making the safety floor dependency-free, and making screening fail closed, encodes "safety over availability" structurally rather than relying on every service staying up.

## Consequences

- An LLM-provider outage means the bot **stops coaching** (benign messages included) rather than coaching unscreened — an accepted availability cost.
- Crisis resources are a hardcoded `RESOURCES` const in `crisis-resources.service.ts` and ship compiled into the bot image (no runtime fetch), so they survive total backend outage.

## Amendment (2026-06-07): neo4j joins the Mem0 degradation set (ADR-0025)

Memory is now **hybrid** (ADR-0025): a self-controlled **neo4j** graph runs alongside the Qdrant vectors. The "Mem0 / Qdrant / embeddings down → coach proceeds buffer-only" line above now reads **"Mem0 / Qdrant / neo4j / embeddings down."** neo4j is a **hard Mem0 dependency**, so a neo4j outage can take *all* of Mem0 down — losing both vector and graph personalization, a small regression from vector-only resilience. This stays a non-fatal degradation: the bot's `MemoryStoreService` catches Mem0 errors and returns `[]`, so the coach still degrades gracefully to **buffer-only**.

The **zero-dependency crisis safety floor is unaffected.** The tripwire → resources path never touches Mem0, Qdrant, **neo4j**, embeddings, or the chat LLM; adding neo4j changes nothing about the safety floor. "Safety over availability" holds: a personalization dependency can fail; the one hard promise cannot.
