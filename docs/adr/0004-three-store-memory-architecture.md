# Three-store split: Record (Postgres) / Memory (Mem0) / Strategy (Qdrant)

Wabi keeps three kinds of data in three stores, with a strict boundary so it's always clear where something belongs:

- **Record — PostgreSQL (Prisma).** The system of record: structured, person-logged events (Mood, Tilt Session, Playtime, Journal Entry, Streak). Authoritative, queryable, exportable.
- **Memory — Mem0.** Derived personalization the AI Coach infers about a person ("tilts in ranked", "prefers breathing exercises"). Durable but **rebuildable** from Records and conversation; never a source of truth.
- **Strategy — Qdrant.** A *shared, non-personal* library of evidence-graded coping techniques, retrieved via RAG. Identical for every user; it is the source the **Reset Technique** is drawn from. Contains no personal data.

## Deletion

A person's "delete my data" request must purge **Postgres rows, all Mem0 memories for the user, and Escalation Events** (all personal). The rule is **"never delete shared knowledge,"** not "never touch Qdrant": the shared **`wabi_strategies`** collection is never purged, but Mem0 *does* store the person's memory vectors in Qdrant (per-user `mem0_<userId>` namespace, see ADR-0017 / amendment below), and **those personal vectors must be purged** — deletion drops the `mem0_<userId>` collection. Any new personal-data store added later inherits this rule.

> **Amendment (post-ADR-0015/0017):** the original wording "Qdrant is never touched — it holds no personal data" predates self-hosting Mem0 *on Qdrant*. Mem0 personal vectors live in Qdrant and **are** deleted; only the shared Strategy collection is exempt. Verify Mem0's delete path actually evicts vectors from Qdrant (drop `mem0_<userId>`); if per-user collections prove unsupported, fall back to `Mem0.deleteAll({user_id})` against a shared collection.

## Amendment (2026-06-07): Memory now has two physical backends — Qdrant vectors + neo4j graph (ADR-0025)

Memory goes **hybrid** (ADR-0025): Mem0 now stores per-user data in **both** Qdrant vectors (`mem0_<userId>`) **and** a self-controlled **neo4j** entity/relationship graph, namespaced by the same `user_id`. The three-store split is **conceptually unchanged** — Record (Postgres) / Memory (Mem0) / Strategy (Qdrant `wabi_strategies`) still holds; "Memory" simply now has two physical backends behind one Mem0 boundary. Memory remains derived, rebuildable, and non-authoritative.

The deletion rule **extends to the graph.** "Delete my data" must purge the user's **neo4j subgraph** in addition to their Postgres rows, Qdrant `mem0_<userId>` vectors, and Escalation Events. The "never delete shared knowledge" carve-out is unchanged: only the shared `wabi_strategies` collection is exempt. Mem0's `delete_all(user_id=...)` is expected to cascade to neo4j with graph enabled (to be verified; fallback is an explicit graph-delete in the Mem0 image). The standing rule — *any personal-data store added later inherits this deletion rule* — now explicitly covers the neo4j personal graph.

## Why

The Record/Memory/Strategy boundary removes the "where does this go?" ambiguity for a data shape that could otherwise plausibly live in either Postgres or Mem0. Making Memory explicitly rebuildable and non-authoritative means a Mem0 outage or wipe degrades personalization without losing real data. Defining the deletion path up front is a requirement for a product handling sensitive mental-health-adjacent data (ADR-0001, ADR-0002), not an afterthought.

## Consequences

- Carries lock-in to Mem0 and Qdrant as managed dependencies.
- Personalization can always be rebuilt from Records; Records can never be reconstructed from Memory.
