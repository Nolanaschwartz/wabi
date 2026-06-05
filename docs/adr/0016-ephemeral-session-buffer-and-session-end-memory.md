# Conversational context lives in an ephemeral Redis buffer; Memory is derived at session end

Within-session continuity for DM coaching (ADR-0015) lives in a **self-hosted Redis** buffer — `wabi:sess:<userId>` holding the last ~10 turns plus a `lastSeen` timestamp and `sessionId`. **Redis runs with persistence disabled (no RDB, no AOF)** so conversational turns never reach durable disk. Cross-session continuity comes from derived **Memory** (Mem0), which is written **at session end**, not per message: a scheduler **sweeper** finds sessions idle > 30 minutes, runs one extraction pass into Mem0, writes the `AiConversation.topic` metadata, and deletes the Redis key. A long Redis TTL exists only as a crash backstop; **logical session expiry is sweeper-driven, not TTL-driven** (TTL eviction would destroy the buffer before it could be flushed).

This is the concrete implementation of ADR-0013 (no durable transcript) and ADR-0004 (Memory is derived/rebuildable), and Mem0's own **history store is disabled** so only derived vectors persist.

## Why

- **Persistence-off Redis** keeps the live buffer fast and multi-process-safe while guaranteeing, by construction, that the verbatim turns ADR-0013 forbids never hit disk. The verbatim already lives in the person's Discord DM.
- **Session-end (not per-message) extraction** is both cheaper and sufficient: the Redis buffer already covers the *live* session, so Mem0 only needs to be ready for the *next* one. This turns one Mem0 LLM-extraction call **per message** into one **per session** — a large reduction on a self-hosted model.
- **Sweeper-driven expiry** is forced by the above: if Redis hard-TTL-evicted the key, there would be nothing left to flush to Mem0.

## Consequences

- A `redis` service is added to `docker-compose` (persistence off) and a Redis client to the bot; this is the store that makes multi-process bot scaling possible later.
- A scheduler sweep owns session finalization (extract → Mem0 → write `topic` → delete key).
- If the process dies mid-session before a flush, that session's **Memory** is lost — acceptable: Memory is rebuildable (ADR-0004) and structured **Records** (Mood, Tilt, etc.) are written eagerly by their own commands regardless.
- Mem0 must be configured with its history/SQLite store off, or it reintroduces the transcript ADR-0013 forbids.
