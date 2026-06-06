# Strategy library: trust-but-monitor, gated on source provenance (not LLM-claimed evidence)

Wabi's Strategy library (Qdrant, ADR-0004) grows partly through automated pipelines (`research-cron`, `session-mining`). Because Strategies are coping advice served to people in distress (ADR-0001), what may auto-publish is tightly constrained.

## The rule

- **Auto-approve only content extracted from an allowlist of authoritative sources** (e.g. PubMed, NIH, peer-reviewed journals). **Provenance is the trust signal — never the LLM's self-assigned `evidenceLevel`**, which is treated as a suggestion only. A model cannot promote its own output by claiming high evidence.
- **Everything else goes to a human review queue** — non-allowlisted sources, anything low-provenance.
- **Session-mined content never auto-serves.** Mining produces *gap signals and drafts only*; it is human-gated. This also protects the privacy boundary: user conversations (inner state, ADR-0002) must never become shared, non-personal library content (ADR-0004).
- **A safety filter screens every Strategy** (auto or human) before serving — rejecting harmful, contraindicated, or clinical-overreach advice (e.g. medication guidance, anything that oversteps non-clinical scope).
- **Faithfulness check on the auto-publish path.** Allowlisting verifies *where a draft came from*, not *whether the source actually says it*. So before an allowlisted draft auto-publishes with no human, a grounding check must confirm the extracted technique is **actually supported by the cited source** — catching a faithful-looking but hallucinated extraction that a URL-only provenance check would miss. (Less critical when a human reviews; essential when nothing else does.)
- **Monitor and auto-demote:** sustained negative feedback quarantines a Strategy; a human audits the auto-approved set periodically; pulling a Strategy is one click.

> **Note (auto-publish enabled in v1).** v1 runs with auto-publish **on** from day one (allowlisted + safety-filter + faithfulness → Qdrant, no human). With no human in the loop for allowlisted sources, the **tightness of the allowlist, the safety filter, and the faithfulness check carry all the pre-publish safety weight**, and auto-demote is the post-publish backstop. Keep the allowlist conservative and audit the auto-approved set on a schedule.

## Why

Automated knowledge growth is worth the scale, but mental-health advice cannot ride on a self-reported trust score. Anchoring auto-publication to source provenance, screening everything for safety, and making removal cheap keeps the library scalable without letting unvetted or user-derived advice reach a vulnerable person.
