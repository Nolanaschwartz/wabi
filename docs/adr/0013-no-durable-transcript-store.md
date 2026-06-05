# Wabi does not persist verbatim conversation transcripts

Wabi keeps **no durable store of verbatim coaching conversations**. `AiConversation` stays metadata-only (`sessionId`, `topic`) — this is intentional, not a gap.

- **Within-session continuity:** a short-lived, ephemeral session buffer (short TTL), not a permanent table.
- **Cross-session continuity:** Mem0 derived **Memory** (ADR-0004) — Wabi remembers the *gist*, not the words.
- **User access to their history:** the verbatim transcript already lives in the person's **Discord DM** (Wabi is DM-first, ADR-0003), so Wabi does not duplicate it.
- **Langfuse** is ops-only: short retention, crisis turns scrubbed (ADR-0010), under the delete-my-data path (ADR-0004). It is **not** a user-facing conversation archive.

## Why

A verbatim transcript is the single most sensitive data Wabi touches. Because Discord already stores it in the user's own DM, persisting a second copy adds breach surface and a deletion burden for ~zero product gain. Not storing it is consistent with derived/rebuildable Memory (ADR-0004), minimal inner-state retention (ADR-0002), and the refusal to store raw crisis content (ADR-0010).

## Consequences

- Wabi cannot show "your past conversations" in-app (Discord DM history covers this).
- Continuity quality depends on Mem0 doing its job; if Mem0 is wiped, continuity degrades but no real data is lost.
- A future "chat history" feature would reverse this ADR and must re-justify storing transcripts at rest.
