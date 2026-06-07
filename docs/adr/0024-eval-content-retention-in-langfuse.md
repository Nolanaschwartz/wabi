# Non-crisis coaching content is retained in full in Langfuse for eval data; crisis content is never traced

Wabi retains **full, un-truncated** non-crisis coaching content (the `input`/`output` of classify, retrieval, and coach steps) in Langfuse traces, to serve as eval and quality data (ADR-0014). This is permitted **only** because Langfuse runs **self-hosted, single-tenant, on Wabi's own infrastructure** (the same topology mandated for personal-data sub-processors by ADR-0017). Crisis traces and crisis scores are **dropped entirely** before any payload is built — they are never sent to Langfuse under any retention posture.

This supersedes the prior interim behaviour (truncating non-crisis content to 200 characters), which was never sanctioned by any ADR and which leaked partial content without delivering usable eval data.

## Why

The audit (issue #20/#35) flagged that non-crisis Langfuse content had no recorded decision: 200-char truncation is neither a true privacy control (it still ships partial personal content) nor useful eval data (it cuts off mid-turn). A safety/coaching product needs honest eval data — real conversations, scored — to measure classifier accuracy, retrieval relevance, and coach quality (ADR-0014). Truncated fragments cannot support that. The operator's decision is therefore to keep full content for evals, accepting the privacy trade-off because the store is on-infra and single-tenant.

## Tension with ADR-0013 and ADR-0002 (acknowledged)

This is a **deliberate, scoped exception** to **ADR-0013 (no durable transcript store)** and sits in tension with **ADR-0002 (inner state stays private)**. Full coaching content in durable Langfuse traces is, in effect, a partial transcript store. The exception is bounded by:

- **Crisis content is never traced** — the most sensitive class is excluded categorically (the `isCrisis` drop in `LangfuseTracer.trace`/`score`).
- **On-infra, single-tenant only** — traces never leave Wabi-controlled infrastructure (ADR-0017). If Langfuse were ever hosted by a third party, this ADR is void and content must be dropped or redacted.
- **Access-controlled** — the Langfuse instance is operator-only; trace content is not a user-facing or exported surface, and is excluded from the data-export/delete rights flows' "no durable transcript" guarantee discussions only insofar as it is operator eval data, not user-owned records.

## Consequences

- `LangfuseTracer` sends `input`/`output` verbatim for non-crisis traces (no truncation, no redaction); crisis short-circuits before payload construction. A test asserts full retention for non-crisis and the existing drop for crisis.
- **Required before launch (HITL):** the consent/privacy disclosure (currently `PLACEHOLDER — Pending legal review`) must state that non-crisis coaching content is retained on Wabi infrastructure for quality/eval purposes. This ADR does not satisfy that disclosure requirement on its own.
- **Recommended guardrails (follow-up):** a bounded retention window on the self-hosted Langfuse project (e.g. delete traces older than N days) so eval retention does not become indefinite, and confirmation that the user data-delete flow either reaches Langfuse trace content or that traces are pseudonymous enough that this is acceptable. These are not yet implemented.
