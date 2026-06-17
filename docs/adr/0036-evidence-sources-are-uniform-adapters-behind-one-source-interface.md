# Evidence sources are uniform adapters behind one `Source` interface

The research agent stops knowing the shape of each evidence source. PubMed, medRxiv, and PsyArXiv become **adapters implementing a single `Source` interface** (`sources/source.ts`): `kind`, `search(query, limit) → Paper[]`, `hydrate(paper) → Paper`, `fullText(paper) → string | null`, and an optional `expand?(paper) → Paper[]`. The agent holds a `Map<SourceKind, Source>`, fans `search` out across it, and dispatches `hydrate`/`fullText`/`expand` back to the owning adapter by `paper.sourceKind`. The per-kind `if/else` full-text routing and the scattered `sourceId.replace('PMID:', '')` id-prefix handling are deleted — each adapter owns its own id keyspace.

This replaces the two ad-hoc interfaces (`PubMedLike` with five methods returning ids; `MedrxivLike` with two returning whole `Paper`s) that lived **inside** `research-agent.ts`. `AgentDeps` collapses from seven flat fields (`pubmed, medrxiv, psyarxiv, seen, gate, extract, dedup`) to five (`sources` map + the four pipeline closures).

## Why

- **Adding a source was an O(sources) edit across the agent.** A fourth source meant a new `SourceKind`, a new `AgentDeps` field, a new wiring line, **and** a new branch in the agent's routing `if/else` — with a comment warning that a catch-all arm would mis-route an `osf:` id into `medrxiv.fullText`. The knowledge of "which id-prefix maps to which fetcher" was spread across `types.ts`, the agent's string-replacements, and each source tool. One `Source` interface concentrates that: a new source is one adapter, zero agent edits.
- **Three adapters justify the seam.** PubMed, medRxiv, and PsyArXiv already exist; the preprint pair was already forced into a shared `MedrxivLike`. This is a real seam (≥2 adapters), not a speculative one.

## Considered options — why `hydrate`, not eager `Paper`s

The surprising part a future reader will question: **why does `search` return *thin* `Paper`s for PubMed and a separate `hydrate` step fill them in, instead of `search` just returning complete `Paper`s like the preprint sources do?**

- medRxiv's and OSF's list endpoints return the abstract inline, so their `search` yields complete `Paper`s and their `hydrate` is the **identity function**.
- PubMed's list endpoint (`esearch`) returns **PMIDs only**. A complete `Paper` needs two more rate-limited NCBI calls (`esummary` + `efetch` for title/pubTypes/abstract).
- **Eager** (rejected): make PubMed's `search` do those two calls for every hit. Simpler interface (`search` + `fullText`, no `hydrate`), but it fetches the abstract for papers the agent then skips — and the agent skips many: the `seen` check drops anything already in the strategy library, common on the re-runs the worker is built to do. That burns the keyless NCBI budget (~3 req/s) on work that's thrown away.
- **`hydrate` step** (chosen): `search` returns thin `Paper`s (id + kind + url); the agent runs the `seen` check first and only `hydrate`s survivors. Preserves today's laziness exactly — abstracts are fetched only for papers that reach the relevance gate. Cost is one extra interface method, free for the preprint sources.

`expand?` is optional for the same shape-honesty reason: PubMed has citation-graph discovery (`related`, gated by `maxDiscoverySteps`); the preprint sources don't. Making it optional keeps the capability first-class for a future citation-graph source without forcing the preprint adapters to stub it.

## Consequences

- **The agent loop is source-agnostic:** `search all (parallel, agent-level fail-soft) → Paper[] queue → per item: seen → hydrate → gate → expand? → fullText → extract → dedup`. All bounds/budget/`visited` logic and fail modes (`fullText → null`, `expand → []`, `hydrate` throw → per-item error) are unchanged.
- **PubMed's public surface shrinks to the `Source` interface.** `summary`/`abstract`/`related` become private implementation details of `hydrate`/`expand`; their specs now assert through the interface (a populated `Paper`, thin expanded `Paper`s) rather than on raw strings — the interface is the test surface.
- **`Paper.sourceKind` is the dispatch key** — it already exists, so no `Paper` change. `Source.kind` lets the runner build the `Map` (insertion order `pubmed → medrxiv → psyarxiv` preserves today's queue order).
- **Per-source tuning stays env-only for now.** This ADR does not move the source knobs (`windowDays`, `maxRecords`, …) onto the DB/admin config seam that run bounds use (ADR-0034); that asymmetry is noted as a separate, lower-stakes opportunity.
