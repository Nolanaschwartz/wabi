# Three-store split: Record (Postgres) / Memory (Mem0) / Strategy (Qdrant)

Wabi keeps three kinds of data in three stores, with a strict boundary so it's always clear where something belongs:

- **Record — PostgreSQL (Prisma).** The system of record: structured, person-logged events (Mood, Tilt Session, Playtime, Journal Entry, Streak). Authoritative, queryable, exportable.
- **Memory — Mem0.** Derived personalization the AI Coach infers about a person ("tilts in ranked", "prefers breathing exercises"). Durable but **rebuildable** from Records and conversation; never a source of truth.
- **Strategy — Qdrant.** A *shared, non-personal* library of evidence-graded coping techniques, retrieved via RAG. Identical for every user; it is the source the **Reset Technique** is drawn from. Contains no personal data.

## Deletion

A person's "delete my data" request must purge **Postgres rows and Mem0 memories** (both personal). **Qdrant is never touched** — it holds no personal data. Any new personal-data store added later inherits this rule.

## Why

The Record/Memory/Strategy boundary removes the "where does this go?" ambiguity for a data shape that could otherwise plausibly live in either Postgres or Mem0. Making Memory explicitly rebuildable and non-authoritative means a Mem0 outage or wipe degrades personalization without losing real data. Defining the deletion path up front is a requirement for a product handling sensitive mental-health-adjacent data (ADR-0001, ADR-0002), not an afterthought.

## Consequences

- Carries lock-in to Mem0 and Qdrant as managed dependencies.
- Personalization can always be rebuilt from Records; Records can never be reconstructed from Memory.
