# Wellbeing

One person's inner state and gaming habits, plus the AI coach that reflects on them. This is the heart of Wabi: mood, tilt, playtime, journaling, and coaching. Non-clinical by design (see `docs/adr/0001-non-clinical-positioning.md`).

## Language

### Inner-state records

**Mood**:
A point-in-time *snapshot* of a person's general wellbeing, rated 1–5 with an optional emoji and note. Instantaneous — it has no start, end, or resolution.
_Avoid_: feeling, vibe-check, emotion log

**Tilt**:
A gameplay-induced *episode* of emotional dysregulation — frustration or anger that degrades both play and wellbeing. Tilt is specifically tied to gaming; a bad day unrelated to play is low Mood, not Tilt.
_Avoid_: rage, anger, breakdown, mental-health episode

**Tilt Session**:
The tracked *interval* of a Tilt episode: it starts on a trigger, carries a 1–10 severity, offers a Reset Technique, and ends when `resolved`. A Mood is never silently promoted into a Tilt Session — tilt language in a mood note only *prompts* the user to start one.
_Avoid_: tilt log, tilt entry

**Reset Technique**:
A short coping action the bot offers during a Tilt Session to help the person de-escalate (e.g. a breathing exercise, a break). Coaching, never treatment.
_Avoid_: intervention, therapy exercise

**Playtime**:
Tracked time spent gaming, used to power gentle guardrails (break nudges, session-length warnings). A wellbeing signal, not a productivity metric.
_Avoid_: screen time, usage

**Journal Entry**:
A written reflection by the person in response to a prompt, optionally annotated with an AI insight.
_Avoid_: note, diary post

**Screened-record write**:
The single path every person-initiated free-text **Inner-state record** (a Mood note, a Tilt trigger, a Journal Entry) crosses on its way to storage — ephemeral reply, **Crisis Screening**, persist, consent-gated **Memory** derivation, then the first-use consent prompt — so the privacy choreography is identical regardless of which command surfaced the words (ADR-0028/0029). The "did this write carry minable free text" condition is decided **once** and gates both derivation and the consent prompt together. A structured-only log (a rating-only Mood) crosses it but derives no Memory; **Playtime** never enters it (no free-text field). Owned by one deep module, `InnerStateLogger`. The write is **transport-agnostic** (ADR-0031): the module owns the persist → derive → consent tail and returns a renderable outcome, while **Crisis Screening** is carried in as a proof token (not re-run) — so the DM surface reuses the **Crisis Classifier** verdict that already screened the turn, and the slash surface screens inline. The "a write cannot skip screening" guarantee is upheld by the type (the tail is uncallable without the proof). The proof now reaches **past the tail to the persist writers**: `JournalService.write` and `MoodService.createNote` take a `ScreenedText` (the minable arm of the proof), not a bare string, so a free-text inner-state field structurally cannot be persisted unscreened — the DM mood spoke, holding no proof, is barred from `createNote` and must use the structured-only `create`. **Tilt's `acceptOffer` is the recorded exception** (ADR-0031): its stored trigger is a bounded label (the raw trigger when present, else `'unknown'`, or a detector keyword on the shared DM accept path), not uniformly minable free text, and the slash trigger is already screened by the logger before it runs — so it stays string-typed rather than forcing a proof through the tilt offer state machine.
_Avoid_: log helper, write wrapper, screened path (when precision matters)

**DM-screened batch**:
The branded proof that this DM turn's coalesced batch was screened crisis-safe by the upstream **Crisis Classifier**, carrying the exact screened text. It is the token a DM spoke uses to mint a **Screened-record write** proof without a second classifier call (ADR-0030/0031): the mint vouches only when the text about to be persisted is byte-identical to the batch, so a `Screened` proof can never stand for text that was not screened, and the token itself is obtainable only past the per-turn safe verdict. A handler that would persist a *transform* of the batch gets no proof and must re-screen.
_Avoid_: screened string, upstream verdict (when precision matters — it is a typed token, not a raw string)

### Coaching

**AI Coach** (the act: **Coaching**):
Wabi's conversational support persona. It reflects, encourages, and suggests habits. It is explicitly **not** a therapist and does not diagnose or treat (ADR-0001). The persona is independent of the underlying model — inference runs behind a swappable, OpenAI-compatible interface (ADR-0009).
_Avoid_: therapist, counselor, therapy, treatment, clinician

**Spoke**:
A capability area a DM turn can be routed to — **journal**, **mood**, **tilt**, or the **AI Coach** itself (the universal fallback). A uniform deep module (ADR-0032): exposes a set of **Tools**, handles a fresh turn via `invoke`, resumes a two-turn capture via `resume`, and either *handles* the turn or *falls through* to coaching. The hub (the DM router) owns the safety floor and routing; each spoke owns its Tools and capture logic.
_Avoid_: handler, command, feature (too generic)

**Tool**:
A single capability a **Spoke** exposes and the intent router selects — e.g. journal's `save_entry`, `get_entry`, `give_prompt`. Carries its own access tier (`any` for reads, `active` for writes and new logging — ADR-0011); may *arm a floor* for a two-turn capture. Adding one is a single declaration the router's prompt is generated from (ADR-0032).
_Avoid_: action, command, function (when precision matters), intent (that is which Spoke, not which capability)

**Check-in**:
A *bot-initiated* prompt to the person — a routine wellbeing nudge, a break reminder, or a playtime warning. Distinct from a Mood, which is *person-initiated*. Opt-in, user-paced, quiet-hours aware, and sparing (ADR-0008); it lands in the person's DMs, so Wabi initiates contact on the person's terms.
_Avoid_: ping, notification, alert

**Contact Policy**:
The cross-cutting rule that decides whether — and when — Wabi may send *any* bot-initiated message, evaluated per *kind* of contact against the person's settings and the current time. A routine **Check-in** is subject to all of it (opt-in, quiet hours, sparing rate); a Crisis Aftermath follow-up is exempt from opt-in and the sparing rate but still **respects quiet hours** — so a follow-up owed during quiet hours defers to the next allowed window rather than waking the person. The single seam every initiator (Check-in scheduler, crisis follow-up, planned playtime/streak nudges) crosses before a DM goes out.
_Avoid_: rate limit (too narrow), notification settings

**Crisis Escalation**:
The hard safety boundary (ADR-0001): when a person expresses crisis-level distress, the AI Coach stops coaching and surfaces real crisis resources. It overrides all other coaching behaviour and is unconditional — it fires even without Active Access (ADR-0005).
_Avoid_: intervention, crisis coaching

**Crisis Tripwire**:
The cheap, always-on keyword/regex backstop that catches the most explicit crisis phrases independent of any LLM call or coaching turn (ADR-0006). One of two detection layers; the other is the **Crisis Classifier**.
_Avoid_: filter, keyword detector (when precision matters)

**Crisis Classifier**:
The contextual LLM detection layer (ADR-0006) — the second of the two crisis-detection layers, catching paraphrased or context-dependent distress the Crisis Tripwire's fixed patterns miss. **Fails closed**: if it cannot run, it returns crisis (ADR-0021). Runs only for a consented person (ADR-0011), whereas the Tripwire runs unconditionally.
_Avoid_: filter, sentiment analysis, moderation

**Crisis Screening** (the act):
Running the two detection layers — Crisis Tripwire then Crisis Classifier — over a piece of a person's free-text input and, on a hit, performing a Crisis Escalation. **Every free-text field a person can express distress into must cross it** — a Mood note, a Tilt trigger, a Journal Entry, a DM — so the safety response is identical regardless of which command surfaced the words; an unscreened free-text field is a safety gap. Atomic surfaces (a Mood note, Tilt trigger, Journal Entry) screen in one call; the DM path runs the Tripwire *before* burst-coalescing and the Classifier *after*, but either layer routes its hit through the one Escalation seam. An inner-state-field crisis escalates resources + Escalation Event but **not** the DM-session Crisis Aftermath — a logged field is not a Conversation.
_Avoid_: moderation, content screening

**Crisis Surface**:
The *kind* of input a Crisis Escalation fired on — the one axis that varies what happens after resources are surfaced. A **Conversation** surface (a live DM turn) opens the Crisis Aftermath; a **field** surface (a logged Mood note, Tilt trigger, or Journal Entry) escalates resources + Escalation Event only — a logged field is not a Conversation, so it never opens the Aftermath Window (ADR-0010/0028). Every escalation names its surface; the surface→aftermath mapping lives in one place so the DM path and the screened-field path cannot drift.
_Avoid_: channel, source, context (too generic)

**Crisis Resources**:
The locale-appropriate hotlines and support lines Wabi surfaces on escalation, keyed by the person's Discord locale. Wabi points to these; it never substitutes for them.
_Avoid_: helpline list, referrals

**Escalation Event**:
The minimal, content-free record that a Crisis Escalation occurred — a timestamp and which detection layer fired (tripwire vs. classifier), never the raw message (ADR-0010). Personal data; deletable. Wabi never notifies third parties off the back of it.
_Avoid_: incident, crisis log (implying stored content), alert

**Crisis Aftermath**:
The period after a Crisis Escalation, governed by two *distinct* pieces of state (ADR-0010). The **do-not-mine flag** is durable (Postgres, on the session) and tells the session-end sweeper to never derive Memory from that session. The **Aftermath Window** is time-bounded (a 24h Redis key) and softens the AI Coach's tone while it lasts; a fresh, live Conversation cancels the window early. The two are set together on escalation but answer different questions — "may we ever mine this?" vs. "is the person still in the immediate aftermath right now?" — and must not be conflated.
_Avoid_: cooldown, lockout, ban (none of these — coaching still happens, just gently)

### Memory & knowledge (ADR-0004)

**Record**:
A structured, person-logged event stored in Postgres — a Mood, Tilt Session, Playtime, Journal Entry, Streak. The system of record: authoritative, queryable, exportable.
_Avoid_: entry (when precision matters), data point

**Memory**:
A durable fact the AI Coach *infers* about a person to personalize coaching (e.g. "tilts in ranked", "prefers breathing exercises"), held in Mem0. Rebuildable from Records and conversation; never a source of truth. Derived **at session end**, not per message (ADR-0016). Mem0 is **hybrid** (ADR-0025): facts live in **both** a per-user Qdrant vector namespace **and** a self-controlled **neo4j** graph that captures the *relationships* between facts ("lost his job" → "tilts more since"). Both backends are embedded/extracted by a **self-hosted** embedder + personal-data-tier extraction LLM, and **both** are purged when "delete my data" runs (ADR-0017, ADR-0004, ADR-0025).
_Avoid_: note, profile fact, record

**Conversation** (a **Session**):
A coaching exchange — in v1, a free-form **DM** thread (ADR-0015). Wabi stores only its *metadata* (session id, topic) — the verbatim transcript is **never persisted** (ADR-0013). Within-session continuity comes from a short-lived **Redis buffer** (persistence off, ~10 turns); a session is bounded by **30 minutes of inactivity**. Cross-session continuity comes from derived Memory, extracted **at session end** by a sweeper (ADR-0016). The verbatim record lives in the person's Discord DM, not in Wabi.
_Avoid_: transcript, chat log, message history

**Strategy**:
An evidence-graded coping technique in Wabi's *shared, non-personal* knowledge library (Qdrant), retrieved via RAG. The same for everyone; it is the source a **Reset Technique** is drawn from. Only allowlisted-provenance content auto-publishes; everything else is human-reviewed, and all Strategies pass a safety filter (ADR-0012). Never authored from a person's conversation.
_Avoid_: tip, content, knowledge-base entry

**Strategy Draft**:
A proposed Strategy awaiting approval (from `research-cron`, `session-mining`, or a human author). Drafts are never served until approved; session-mined drafts are always human-gated (ADR-0012). A Draft's status (pending-review → published / quarantined) lives in Postgres, but the **Qdrant index is the serving surface**: a *published* Draft must be present in the index and a *quarantined* one absent. The two are **reconciled, never assumed** — so a quarantined Strategy can't keep being served on a silently-failed index delete, nor a published one stay invisible on a failed upsert. The **legal status transitions** (pending-review → published via approve, → quarantined via reject; published → quarantined via demote) live behind one module, `StrategyDraftStateMachine` — a pure `nextStatus` table plus a guarded atomic write — so the operator paths no longer each copy the `status !==` guard. The state machine deliberately does **not** touch the index; the caller keeps ADR-0012's index ordering (approve indexes *before* the status write via a `precommit` gate; reject/demote delete *after*). The durable demote job (`applyDemote`) stays outside it — downstream of its own guard and also resetting `negativeCount`, it is a counter-reset, not a pure transition.
_Avoid_: pending strategy, suggestion

**Run Bounds**:
The per-run resource caps a single research run obeys — papers-per-topic, drafts-per-topic and per-run, the agent/run timeouts, and the token budget. They have **one owner** (`run-bounds.ts`: the field set, defaults, valid ranges, and the `ResearchConfig`-row→bounds mapping); the `ResearchConfig` singleton in Postgres is the source of truth after first boot (ADR-0034), with env (`RESEARCH_MAX_*`) demoted to bootstrap seed defaults. The code defaults must mirror the schema's `@default`s — they are the fallback when the row can't be read, so a drift between them silently changes how much a degraded run mines. `searchLimit` (search breadth) is resolved alongside the bounds but is env-sourced, **not** a bound column.
_Avoid_: config, limits, quota (too generic)

### Progress (personal, DM-first per ADR-0003)

**Engagement** (a logged habit-event):
One record that a person performed a self-care habit — a coaching turn, a Journal Entry, an answered Check-in. The single unit behind all gentle gamification: a **Streak** is consecutive days with ≥1 Engagement, **XP** is the sum of points carried per Engagement, and the **Wellness Score** is Engagement density over a window. Recorded exactly once per habit-event through one writer, so no surface hand-wires rewards and no event is counted twice. Which habits count, and for how much XP, is a gentle-gamification decision (ADR-0007).
_Avoid_: activity, event (too generic), "xp entry" (the old row that conflated points with the engagement signal)

**Streak**:
A running count of consecutive days a person logged at least one Engagement (e.g. answering check-ins, taking breaks). Global to the person; not server-scoped. Treated gently (ADR-0007) — a broken streak is framed with compassion, never as failure, and streak nudges yield when the person is struggling.
_Avoid_: chain, combo

**XP / Level**:
Lightweight progress points and tiers — the sum of points carried by each Engagement. Motivational only; never tied to Mood or Tilt severity (ADR-0002).
_Avoid_: score, points (ambiguous), rank

**Wellness Score**:
A private, person-global measure of *healthy-habit engagement* — Engagement density over a window. It deliberately reads only Engagement, never Mood or Tilt (ADR-0002), so it can never expose how someone feels — and counts each habit-event once.
_Avoid_: health score, mood score, mental-health score

## Example dialogue

> **Dev:** User just lost a ranked match and ran `/mood`, rated 2 with the note "so tilted." Do we open a Tilt Session?
> **Domain expert:** No — that's a Mood snapshot. The word "tilted" is a *signal*, so the coach offers: "Want to start a tilt reset?" If they say yes, *then* we open a Tilt Session with its own severity and a Reset Technique.
> **Dev:** And if the note said "I don't want to be here anymore"?
> **Domain expert:** That's not coaching territory at all — that trips Crisis Escalation. The coach drops everything and surfaces crisis resources.
