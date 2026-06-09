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

### Coaching

**AI Coach** (the act: **Coaching**):
Wabi's conversational support persona. It reflects, encourages, and suggests habits. It is explicitly **not** a therapist and does not diagnose or treat (ADR-0001). The persona is independent of the underlying model — inference runs behind a swappable, OpenAI-compatible interface (ADR-0009).
_Avoid_: therapist, counselor, therapy, treatment, clinician

**Check-in**:
A *bot-initiated* prompt to the person — a routine wellbeing nudge, a break reminder, or a playtime warning. Distinct from a Mood, which is *person-initiated*. Opt-in, user-paced, quiet-hours aware, and sparing (ADR-0008); it lands in the person's DMs, so Wabi initiates contact on the person's terms.
_Avoid_: ping, notification, alert

**Crisis Escalation**:
The hard safety boundary (ADR-0001): when a person expresses crisis-level distress, the AI Coach stops coaching and surfaces real crisis resources. It overrides all other coaching behaviour and is unconditional — it fires even without Active Access (ADR-0005).
_Avoid_: intervention, crisis coaching

**Crisis Tripwire**:
The cheap, always-on keyword/regex backstop that catches the most explicit crisis phrases independent of any LLM call or coaching turn (ADR-0006). One of two detection layers; the other is the contextual LLM classifier.
_Avoid_: filter, keyword detector (when precision matters)

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
A proposed Strategy awaiting approval (from `research-cron`, `session-mining`, or a human author). Drafts are never served until approved; session-mined drafts are always human-gated (ADR-0012).
_Avoid_: pending strategy, suggestion

### Progress (personal, DM-first per ADR-0003)

**Streak**:
A running count of consecutive periods a person has kept a self-care habit (e.g. answering check-ins, taking breaks). Global to the person; not server-scoped. Treated gently (ADR-0007) — a broken streak is framed with compassion, never as failure, and streak nudges yield when the person is struggling.
_Avoid_: chain, combo

**XP / Level**:
Lightweight progress points and tiers earned through habit engagement. Motivational only; never tied to Mood or Tilt severity (ADR-0002).
_Avoid_: score, points (ambiguous), rank

**Wellness Score**:
A private, person-global measure of *healthy-habit engagement* — the consistency of self-care actions. It deliberately does **not** read Mood or Tilt (ADR-0002), so it can never expose how someone feels.
_Avoid_: health score, mood score, mental-health score

## Example dialogue

> **Dev:** User just lost a ranked match and ran `/mood`, rated 2 with the note "so tilted." Do we open a Tilt Session?
> **Domain expert:** No — that's a Mood snapshot. The word "tilted" is a *signal*, so the coach offers: "Want to start a tilt reset?" If they say yes, *then* we open a Tilt Session with its own severity and a Reset Technique.
> **Dev:** And if the note said "I don't want to be here anymore"?
> **Domain expert:** That's not coaching territory at all — that trips Crisis Escalation. The coach drops everything and surfaces crisis resources.
