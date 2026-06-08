# Memory goes hybrid: a self-controlled neo4j graph runs alongside the Qdrant vectors

Wabi's derived **Memory** (Mem0) moves from **vector-only** to **hybrid**: a self-controlled **neo4j** graph store is added **alongside** the existing Qdrant vector store, using Mem0's native hybrid mode. A flat vector store retrieves semantically-similar memories but cannot represent the **relationships** between facts a person reveals ("lost his job" → "tilts more in ranked since" → "skips sleep on weeknights") — exactly the connections a graph captures and a vector store misses. This **supersedes the "graph store (neo4j) is *not used* in v1" line** in ADR-0017's 2026-06-06 amendment.

The change is **additive, not a replacement**. Personal Memory now has two physical backends behind one Mem0 boundary: Qdrant `wabi_memories` (`mem0_<userId>`) keeps holding the per-user vectors **and** neo4j holds the per-user entity/relationship graph, namespaced by the same `user_id`. The bot never talks to neo4j directly — it speaks only to Mem0's REST API; Mem0 owns both the Qdrant vectors and the neo4j graph for personal memory.

The three-store model (ADR-0004: Record / Memory / Strategy) is **conceptually unchanged** — "Memory" simply now has two physical backends. Qdrant's admin/authoritative `wabi_strategies` library is untouched: it is still written via the direct Qdrant SDK and is never purged on user delete.

## Why

- **Graphs capture relationships vectors can't.** Coaching value comes from connecting a person's facts over time, not just recalling each in isolation. Mem0's hybrid search blends vector + graph results automatically, so the graph deepens retrieval with no prompt-shaping work in the bot.
- **It costs no new trust boundary.** neo4j holds *derived personal data* (entities/relationships from conversation), so it stays inside ADR-0017's "self-controlled" stance: it is **Wabi's own container** — self-hosted in dev, a Wabi-controlled container in prod (Railway private networking) — **never** a third-party multi-tenant managed graph (e.g. Neo4j Aura). Graph extraction reuses the **same personal-data-tier extraction LLM** and the **same self-hosted embedder** already configured for Mem0; no data crosses a new processor. **No new sub-processor is added.**
- **The original "no neo4j in v1" call assumed graph was a separate, optional cost.** Once confirmed that Mem0's graph memory is *additive* (graph runs alongside the vector store, not instead of it) and reuses the existing extraction LLM + embedder, the privacy and cost objections that motivated deferring it no longer hold.

## Consequences

- A `neo4j` container is added to the deployment (self-hosted dev, Railway-private prod); Mem0 gains a `graph_store` block pointed at it. The Qdrant vector userspace and the `wabi_strategies` admin library are unchanged.
- **Deletion purges the graph too.** "Delete my data" must evict the user's vectors **and** their neo4j subgraph. The bot's existing `DELETE /memories?user_id=mem0_<userId>` routes to Mem0's `delete_all`, which — with graph enabled — **cascades to neo4j** (verified against mem0 0.1.117: a `delete_all` dropped a user's graph from two nodes to zero), so **no bot change is required**. ADR-0004's deletion rule ("never delete shared knowledge; always purge all personal stores") now explicitly covers the neo4j personal graph.
- **Crisis content is still never mined** (ADR-0010/0016), so it never reaches the graph.
- **neo4j is now a hard Mem0 dependency** (honest tradeoff). A neo4j outage can take *all* of Mem0 down — losing **both** vector and graph personalization, a small regression from vector-only resilience. This is accepted because: the **zero-dependency crisis safety floor is unaffected** (ADR-0021) — the tripwire → resources path never touches Mem0, Qdrant, neo4j, or embeddings; and the bot's `MemoryStoreService` already catches Mem0 errors and returns `[]`, so the coach degrades gracefully to **buffer-only** when Mem0 (now including neo4j) is unavailable. ADR-0021's degradation list adds neo4j alongside Mem0/Qdrant/embeddings.
- The graph **builds forward** from new sessions; existing vector memories are not backfilled into it. Like Qdrant Memory, neo4j is rebuildable from Records/conversation and is **not authoritative** — it needs no formal backup (ADR-0020).

See the design spec `docs/superpowers/specs/2026-06-07-hybrid-graph-vector-memory-design.md`.
