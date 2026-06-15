# The research ingestion pipeline always queues for human review; it never auto-publishes

The `research-cron` that ADR-0012 names is implemented as an **isolated worker** (`packages/research`) that agentically researches public biomedical literature (NCBI/PubMed + medRxiv), extracts grounded coaching-strategy candidates, and submits them to the bot over an authenticated endpoint. Every candidate is persisted as a `StrategyDraft` with `trustLevel: 'research-agent'`, and the trust gate routes that level to the **human review queue unconditionally** — even when the source is allowlisted and the safety + faithfulness checks both pass.

This **overrides ADR-0012's auto-publish rule** for the research path. ADR-0012 permits allowlisted-source drafts that pass safety + faithfulness to publish to `wabi_strategies` with no human in the loop, and `ncbi.nlm.nih.gov` is on that allowlist. The research pipeline deliberately does not take that path: an autonomous agent that *discovers its own sources* (branching via `elink` related-articles, and reading not-yet-peer-reviewed medRxiv preprints) is a different trust posture from a fixed allowlisted fetch, and mental-health coping advice surfaced to a vulnerable person (ADR-0001) warrants a human gate when an agent chose what to read.

## Why

- **Agentic discovery changes the provenance argument.** ADR-0012 anchors auto-publish trust on *where a draft came from*. But this agent doesn't just fetch a fixed allowlisted URL — it agentically branches to related papers and reads medRxiv preprints (not peer-reviewed). "It came from NCBI" no longer fully describes how the content was selected, so the provenance-as-trust-signal that justifies auto-publish doesn't hold cleanly. A human reviews what the agent chose.
- **The human reviewer is the scarce resource, and that is acceptable here.** v1's goal is to *prove extraction quality*, not to scale unattended publication. Routing everything to the queue makes every agent output auditable while the extraction is still being trusted. Per-run draft caps (`maxDraftsPerRun`) keep the queue humane.
- **Safety and faithfulness still run — they just can't promote.** The existing `safetyFilter` and `faithfulnessCheck` execute on research drafts, so a reviewer never sees something that failed them. Their result can only gate-to-queue, never auto-publish. The verbatim `sourceText` quote the extractor must return is what `faithfulnessCheck` grounds against.

## Scope and bounds

- **Adds a trust level, not a new gate.** `'research-agent'` joins `allowlisted | community | session-mined`. The trust gate's existing "session-mined → queue regardless" branch gains a sibling; nothing else in the gate changes.
- **The worker never reads or writes the stores directly.** It only calls authenticated bot endpoints — `POST /admin/strategies/ingest` to submit and `GET /admin/strategies/seen` to check a source-ID ledger (`ProcessedSource`) for cross-run idempotency (`AdminGuard` on both). The bot remains the single writer of Postgres and `wabi_strategies` and writes the ledger itself at ingest, so all trust/safety/dedup logic stays single-sourced (ADR-0012/0004) and the worker keeps no DB credentials.
- **Public data only (ADR-0002).** The worker has no access to user data, Redis session buffers, or personal memory. It is a separate, non-always-on process and does not weaken the bot's always-on guarantee (ADR-0019/0020).
- **This is a tightening, not a reversal of ADR-0012.** ADR-0012's auto-publish path remains valid for any *other* future pipeline that fetches fixed allowlisted sources without agentic discovery. This ADR governs only the `research-agent` provenance.

## Consequences

- Drafts from PubMed that pass every check still wait for a human — slower to publish, but no unvetted agent-discovered advice can reach a person.
- medRxiv preprints are ingestible (more recent gaming/wellbeing research often appears there first) because the human gate absorbs their lower evidence weight; they are always tagged `"preprint: not peer-reviewed"`.
- If, after extraction quality is proven, unattended publication of peer-reviewed PubMed drafts becomes desirable, that is a future ADR superseding this one — not a silent config flip.
