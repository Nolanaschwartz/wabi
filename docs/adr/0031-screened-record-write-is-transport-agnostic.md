# The screened-record write is transport-agnostic; screening is proven, not re-run

The **screened-record write** (ADR-0028/0029) becomes a transport-free module — `record(userId, screened, write) → Outcome<T>` — that owns the persist → derive → consent-decision tail and renders nothing. Crisis screening moves out to the surface adapters, and the shared module accepts a branded `Screened<T>` proof so it stays **structurally impossible** to persist unscreened inner-state free text. The DM surface mints the proof from the **Crisis Classifier** verdict that already ran upstream this turn; the slash surface mints it by running `CrisisScreening.guard`. Two thin adapters render the returned `Outcome` — slash via `interaction` defer/`editReply`/`followUp`, DM via `message.reply`.

This supersedes the previous shape, where `InnerStateLogger.log(interaction)` was transport-bound (only slash commands could cross it) and the DM journal spoke re-implemented the tail inline.

## Why

- **There was a real gap.** The DM journal spoke wrote the entry and derived Memory inline (`journal-dm.handler`), duplicating the `Journal:` derive seam and **omitting the first-use consent prompt entirely**. CONTEXT.md claimed the path was "owned by one deep module"; the code disagreed.

- **A branded proof keeps ADR-0028's guarantee without double-screening.** ADR-0028's whole point is that a write *structurally cannot* skip screening. But the DM turn is already screened upstream, inside the `classify ∥ strategy ∥ prepare` block (ADR-0021/0030). Routing it through a module that re-runs `guard` would add a second, serial classifier call to every journal-from-DM save — exactly the latency and token cost ADR-0030 was careful to protect. The `Screened<T>` brand enforces the obligation at the type level (the tail is uncallable without proof) while letting the DM path carry its existing verdict forward instead of re-screening. The seam is real, not hypothetical: there are two genuine mint sites — slash runs `guard`, DM converts its upstream verdict.

- **Returning an `Outcome` beats injecting a transport port.** `deferReply` (slash must ack within 3s, before the classifier call) and the typing indicator (DM, owned by the coaching pipeline) are transport-specific *lifecycle* with no place in the choreography. Returning data leaves them in the adapters where they belong, and makes the module's interface its own test surface — assert on the returned `Outcome`, no discord.js mock.

## Scope and bounds

- The brand is **proof-by-construction**: a single auditable mint site asserts "this exact string was screened safe." Its integrity rests on the persisted content being byte-identical to the screened batch — true for `journal-inline` and `journal-capture` today. A surface that transforms free text before persisting must re-screen (mint by running `guard`, not by carrying an upstream verdict).
  - **Tightened mint contract (later refinement).** The DM mint no longer trusts a bare string. The upstream classifier's safe verdict is now carried as a branded `DmScreenedBatch` holding the exact screened text, and the DM mint is `fromBatch(batch, persistedText, derivePrefix)`, which returns a `Screened` **only when `persistedText` is byte-identical to the batch** — otherwise `null`, and the caller fails safe by re-screening via `screenForRecord`. The "byte-identical" integrity that was previously a convention is thus enforced structurally, and a `DmScreenedBatch` is obtainable only past the per-turn classify (closing the "never screened" mint vector too). No second classifier call is added (ADR-0030 preserved). Substring containment was considered and deferred (YAGNI — no transforming DM handler exists today).
- **Structured-only records** (a rating-only Mood) carry `screened: null` — no free text, no screen, no derive, no prompt — unchanged from ADR-0028.
- This changes the screened-record write's **structure**, not crisis behaviour. Ordering, the escalation seam, and the DM crisis floor staying upstream of routing are untouched (ADR-0021/0030).
- **Refines ADR-0028/0029**, does not reverse them: screening still runs on every free-text inner-state write; its call site is now per-transport, and the obligation is enforced by the `Screened<T>` type rather than by the module always calling `guard`.

## Consequences

- The duplicated derive in `journal-dm.handler` is deleted; the first-use consent prompt now fires on the DM journal path (the closed gap).
- The pre-existing **mark-then-send race** — the consent prompt marks the person "asked" when the prompt is built, before the adapter confirms it sent, so a failed send silently leaves Memory off forever — is unchanged by this work and deferred as a separate hardening (defer the mark until after a confirmed send).
- A new free-text inner-state surface must obtain a `Screened<T>` to persist, so it cannot accidentally skip screening — the ADR-0028 invariant survives the transport split.
