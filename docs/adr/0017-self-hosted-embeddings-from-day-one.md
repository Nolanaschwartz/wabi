# Embeddings are self-hosted from day one; personal-data sub-processors go local first

Wabi self-hosts a single OpenAI-compatible **embedding** endpoint (e.g. TEI/Infinity serving `bge-base-en-v1.5`, **768-dim**) from day one, used for **both** the shared Strategy library (Qdrant `wabi_strategies`) **and** personal Mem0 memories. The chat LLM stays external (OpenAI/GPT-4o) for the PoC behind the swappable interface (ADR-0009). This refines ADR-0009: not all sub-processors swap on the same timeline — **sub-processors that touch personal data go local first; the chat LLM can stay PoC-external longest.**

## Why

- **Privacy asymmetry.** Strategies are non-personal (embedding them externally is low-risk), but Mem0 memories are *derived personal data* ("tilts in ranked", "lost his job"). Embedding those on a third party ships Wabi's most sensitive data off-infra. Local embeddings keep personal data inside Wabi immediately.
- **Dimension lock-in.** Qdrant collections are fixed-dimension. Seeding at OpenAI's 1536 and swapping to a local model later forces a **drop-and-re-embed of `wabi_strategies` and a migration of every Mem0 vector** — a painful dual-store cutover. Pinning the local model's dimension (768) once avoids it entirely.
- Embedding models are small and CPU-viable, so the cost of self-hosting now is one container and a marginal quality drop that is negligible for coping-strategy retrieval.

## Consequences

- An embedding service is added to `docker-compose`; both `qdrant.ts` and Mem0 point at it via a configurable endpoint (no hard-coded `new OpenAI()` for embeddings).
- Qdrant `VECTOR_SIZE = 768` (was 1536); the seed/retrieval code and any fixtures follow.
- The chat LLM remains the one external sub-processor for the PoC, disclosed in consent (ADR-0009) and swappable to local as the destination.

## Amendment (2026-06-06): "self-hosted" → "self-controlled single-tenant"; mem0 extraction LLM is personal-data tier

Production runs on a cloud platform (Railway) that cannot reach the LAN inference boxes used in dev (`192.168.1.x`). We resolve this **without** weakening the privacy stance:

- **"Self-hosted" is generalized to "self-controlled."** Personal-data sub-processors may run on a **privately-managed, single-tenant, OpenAI-compatible endpoint that Wabi controls** (own VPS/GPU host, or a single-tenant managed deployment), reachable over the network with an API key — not only same-LAN. **"External" (forbidden for personal data) means third-party *multi-tenant* services.** The endpoint must guarantee **no training on, and no retention of, request data.**
- **One artifact ships dev→prod**, differing only by env (`*_BASE_URL` / `*_API_KEY`): LAN endpoints in dev, the managed single-tenant endpoint in prod.
- **mem0's memory-extraction LLM is a personal-data sub-processor.** It reads raw conversation text to derive memories, so under this ADR's own privacy-asymmetry principle it sits on the **personal-data (self-controlled) tier** — it may NOT be a public external chat API, even though ADR-0009/0017 let the *coaching* chat LLM stay external longest. (Crisis content is never mined — ADR-0010/0016 — so it never reaches the extraction LLM at all.)
- **The Memory store stays self-hosted regardless:** Qdrant (vectors) + SQLite history live in Wabi's own infra; only embedding/extraction *compute* is the managed endpoint. The graph store (neo4j) is **not used** in v1 (vector-only; graph memory is optional in mem0 and unused).
- The embedding model in practice is `nomic-embed-text-v2-moe` (768-dim), not `bge-base`; the 768-dim lock-in above is unaffected.

See remediation issue #37 (inference topology) and #04/#23 (mem0 deployable image).

## Amendment (2026-06-07): graph store (neo4j) is now used — Memory goes hybrid (ADR-0025)

The 2026-06-06 amendment's line "The graph store (neo4j) is **not used** in v1 (vector-only; graph memory is optional in mem0 and unused)" is **superseded by ADR-0025.** Memory is now **hybrid**: a self-controlled **neo4j** graph runs **alongside** the Qdrant vectors (Mem0's native hybrid mode), additive, not a replacement. The privacy stance in this ADR is unchanged: neo4j is **Wabi's own container** (self-hosted dev / Railway-private prod, never a third-party multi-tenant managed graph), and graph extraction reuses the **same personal-data-tier extraction LLM** and the **same self-hosted embedder** — no new sub-processor, no new trust boundary. The 768-dim embedding lock-in is unaffected. See ADR-0025 for the hybrid shape, the deletion-purges-graph rule, and the graceful-degradation tradeoff.
