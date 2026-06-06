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
