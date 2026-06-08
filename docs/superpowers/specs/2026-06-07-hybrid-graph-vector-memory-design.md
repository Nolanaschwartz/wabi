# Hybrid graph+vector memory: re-enable neo4j in mem0

**Date:** 2026-06-07
**Status:** Approved (design) — pending implementation plan
**Supersedes:** the "graph store (neo4j) not used in v1" line in ADR-0017's 2026-06-06 amendment, and the "no neo4j" decision in the `production-inference-topology` project memory.

## Problem

Wabi's derived Memory (mem0) runs **vector-only** on Qdrant today. A flat vector store retrieves
semantically-similar memories but cannot represent **relationships** between facts a person reveals
("lost his job" → "tilts more in ranked since" → "skips sleep on weeknights"). These connections are
exactly what a graph database captures and a vector store misses. We want mem0 to capture them.

## Decision

Re-enable mem0's **graph memory** by adding a self-hosted **neo4j** alongside the existing Qdrant
vector store — mem0's native **hybrid** mode. This reverses the "no neo4j in v1" decision recorded in
ADR-0017's 2026-06-06 amendment.

- **Personal Memory becomes two backends behind one mem0 boundary:** Qdrant `wabi_memories`
  (`mem0_<userId>`) keeps holding per-user vectors **and** neo4j holds the per-user
  entity/relationship graph, namespaced by the same `user_id`.
- **The three-store model (ADR-0004) is conceptually unchanged.** Record (Postgres) / Memory (mem0) /
  Strategy (Qdrant `wabi_strategies`) still holds. "Memory" simply now has two physical backends.
- **Qdrant's admin/authoritative `wabi_strategies` library is untouched.** It is still written via the
  direct Qdrant SDK (`StrategyRetrievalService` / `StrategyAdminService`) and never purged on user delete.
- **No new sub-processor.** Graph entity-extraction reuses the existing mem0 extraction LLM
  (already on the personal-data / self-controlled tier per ADR-0017) and the existing self-hosted
  embedder. Crisis content is still never mined (ADR-0010/0016), so it never reaches the graph.

> **Naming clarification:** the original ask phrased this as "remove the Qdrant userspace." After
> confirming mem0's graph memory is *additive* (graph runs alongside the vector store, not instead of
> it), the chosen shape is **Hybrid**: keep the Qdrant userspace vectors **and** add the neo4j graph.
> Qdrant continues to hold personal vectors, so user deletion must still purge them.

## Architecture

```
PERSONAL MEMORY (mem0, self-controlled)
  ├─ Qdrant  wabi_memories      per-user vectors      (existing)
  └─ neo4j   per-user graph      entities + relations  ← NEW

ADMIN / AUTHORITATIVE (direct Qdrant SDK, non-personal)
  └─ Qdrant  wabi_strategies     shared coping library  (unchanged)

The bot never talks to neo4j directly. It speaks only to mem0's REST API; mem0 owns
both the Qdrant vectors and the neo4j graph for personal memory.
```

## Implementation

### `docker-compose.yml`
- Add a `neo4j` service: `neo4j:5-community`, APOC enabled, `NEO4J_AUTH=${NEO4J_AUTH}`, ports
  `7474:7474` (browser) and `7687:7687` (bolt), volume `neo4j_data:/data`.
- On the `mem0` service: add `MEM0_GRAPH_URL`, `MEM0_GRAPH_USERNAME`, `MEM0_GRAPH_PASSWORD` env and
  `depends_on: [qdrant, neo4j]`.
- Add `neo4j_data` to the top-level `volumes:` block.

### `infra/mem0/main.py`
- Read `MEM0_GRAPH_URL` (default `bolt://neo4j:7687`), `MEM0_GRAPH_USERNAME` (default `neo4j`),
  `MEM0_GRAPH_PASSWORD`.
- Add a `graph_store` block to `DEFAULT_CONFIG`:
  ```python
  "graph_store": {
      "provider": "neo4j",
      "config": {
          "url": GRAPH_URL,
          "username": GRAPH_USERNAME,
          "password": GRAPH_PASSWORD,
      },
  },
  ```
  Graph extraction reuses the configured `llm` and `embedder` (no separate provider).
- Update the module docstring (the "Graph store: OMITTED" line) and the startup `logging.info(...)`
  line (drop "graph disabled" → "graph enabled via neo4j").

### `.env.example`
- Add under a `# Neo4j (mem0 graph memory, ADR-0025)` block: `NEO4J_AUTH=neo4j/wabi-local`,
  `MEM0_GRAPH_URL=bolt://localhost:7687`, `MEM0_GRAPH_USERNAME=neo4j`,
  `MEM0_GRAPH_PASSWORD=wabi-local`, with the same "do not commit real values; prod sets these in
  Railway env" guidance the inference block already carries.

### Deletion path (delete-my-data)
- The bot's `MemoryStoreService.deleteAllForUser` already calls `DELETE /memories?user_id=mem0_<userId>`,
  which routes to mem0's `delete_all(user_id=...)`. With graph enabled, mem0's `delete_all` purges the
  user's **graph subgraph in addition to** the vectors — so **no bot code change is required**.
- **Verification is mandatory** (not assumed): the plan must confirm mem0 0.1.117's `delete_all`
  cascades to neo4j. If it does not, the fallback is an explicit graph-delete in `main.py`'s
  `delete_all_memories` handler. ADR-0004's deletion rule ("never delete shared knowledge; always purge
  all personal stores") now explicitly covers the neo4j personal graph.

### Dependencies
- The image is `FROM mem0/mem0-api-server:latest`, whose stock config already uses neo4j, so the
  `langchain-neo4j` graph extra is expected to be present — **no Dockerfile change anticipated**. The
  plan must verify this (import check); if absent, add the `mem0ai[graph]` extra to the image.

## Privacy posture (ADR-0017 alignment)

neo4j holds **derived personal data** (entities/relationships from conversation). This stays within
ADR-0017's "self-controlled" stance:

- neo4j is **Wabi's own container** — self-hosted in dev, a Wabi-controlled container in prod (Railway
  private networking), **never** a third-party multi-tenant managed graph (e.g. Neo4j Aura).
- Graph extraction reuses the **same personal-data-tier extraction LLM**; embeddings use the **same
  self-hosted embedder**. No data crosses a new trust boundary.
- Crisis content is never mined (ADR-0010/0016), so it never reaches the graph.
- Deletion purges the user's vectors **and** graph.

## Graceful-degradation consequence (honest tradeoff)

Adding neo4j as a **hard mem0 dependency** means a neo4j outage can take **all** of mem0 down — losing
*both* vector and graph personalization, a small regression from vector-only resilience. This is
acceptable because:

- The **zero-dependency crisis safety floor is unaffected** (ADR-0021) — the tripwire → resources path
  never touches mem0, Qdrant, neo4j, or embeddings.
- The bot's `MemoryStoreService` already **catches mem0 errors and returns `[]`**, so the coach still
  degrades gracefully to buffer-only when mem0 (for any reason, now including neo4j) is unavailable.

ADR-0021's degradation list is updated to add neo4j alongside mem0/Qdrant/embeddings.

## Docs to write / amend

- **New:** `docs/adr/0025-hybrid-graph-vector-memory.md` — format matches the repo convention
  (Title H1 / intro / `## Why` / `## Consequences`). States it supersedes the "no neo4j in v1" line in
  ADR-0017's amendment.
- **Amend** (append-only: dated amendment or targeted inline edit, preserving history):
  - `docs/adr/0017-self-hosted-embeddings-from-day-one.md` — add a dated amendment noting the
    "graph store (neo4j) not used in v1" sentence is superseded by ADR-0025.
  - `docs/adr/0004-three-store-memory-architecture.md` — Memory now = Qdrant vectors + neo4j graph;
    deletion purges the graph too.
  - `docs/adr/0021-graceful-degradation-and-safety-floor.md` — degradation list includes neo4j.
  - `docs/adr/0020-deployment-and-operations.md` — add neo4j to the self-hosted store enumeration
    (lines ~3, 12, 17, 25).
  - `docs/ARCHITECTURE.md` — data-store table (add neo4j row; update the Mem0 row) and the
    personal-data map (add neo4j personal graph + its deletion).
  - `docs/contexts/wellbeing/CONTEXT.md` — Memory definition (add the graph backend).
  - `docs/PLAN.md` — Task 8 reconciliation note that currently implies vector-only.
- **Project memory:** `memory/production-inference-topology.md` — flip "no neo4j" → hybrid; add neo4j
  to the self-controlled store set; keep the custom-image rationale.

## Testing

The bot never talks to neo4j directly, so bot-side test surface is small:

1. **Deletion regression test** — assert delete-my-data purges the user's graph (drives the
   verification of mem0's `delete_all` cascade; if a fallback graph-delete is added to `main.py`, it is
   covered here).
2. **mem0 config smoke check** — `DEFAULT_CONFIG` includes a parseable `graph_store` block when the
   `MEM0_GRAPH_*` env is set.
3. **Image dependency check** — confirm `langchain-neo4j` imports in the mem0 image (gate for whether a
   Dockerfile change is needed).
4. Existing `memory-store.spec.ts` (mocks `fetch`) needs **no change**.

## Out of scope

- Surfacing graph relationships in the coach prompt beyond what mem0's `search` already returns
  (mem0's hybrid search blends vector + graph results automatically; no prompt-shaping work here).
- Any change to the `wabi_strategies` admin library, its retrieval, or its governance (ADR-0012).
- Migrating/backfilling a graph from existing vector memories (graph builds forward from new sessions).

## Risks / open items

- **mem0 `delete_all` graph cascade** — must be verified against 0.1.117; fallback defined above.
- **Stock image graph extra** — must be verified; fallback defined above.
- **Prod neo4j sizing/auth** — Railway neo4j container needs a real password in env and a volume;
  covered by the ADR-0020 amendment and `.env.example` guidance, sized in the implementation plan.
