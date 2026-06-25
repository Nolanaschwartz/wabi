# Voice enforces single-human memory privacy by hanging up on a late joiner, not by mutating a live prompt

The voice surface (`@wabi/call`) recalls a person's derived memory and prepends it to the assistant's
system prompt — but only when **exactly one human** is in the channel (ADR-0002/0017: inner-state and
derived memory must never reach a shared/social surface). That gate (`buildMemoryContext`) is a
**snapshot taken at `/call` time**. A Discord voice channel's membership can change mid-call, and the
snapshot can't see a second human arriving.

We **end the call** the moment a second human joins a call that loaded memory. We considered and rejected
the alternative — a live `setMemoryBlock` seam that strips the recalled facts from the running session's
prompt and continues as a plain assistant.

## Why

- **The blunt fix has no race surface.** Tearing the call down on a membership change is a single,
  observable action: `bridge.stop(guildId)` cascades to `agent.stop` and audio teardown. A live
  prompt-strip has to win a race against the in-flight turn — the assistant could already be mid-sentence
  speaking a recalled fact when the join fires. Ending the call removes that window entirely.

- **The privacy decision stays pure and snapshot-shaped.** `buildMemoryContext` remains a pure
  single-human gate evaluated once at start; the circuit-breaker is a thin guard layered on top
  (`shouldHangUp(memoryLoaded, humanCount)` → `memoryLoaded && humanCount >= 2`). No mutable
  memory-on-a-session machinery, no second code path that can compute the wrong block.

- **Memory-less calls are untouched.** A group call (≥2 humans from the start) or an unknown/unconsented
  user loads no memory, so a late joiner there exposes nothing — `memoryLoaded` is false and the guard
  never fires. Group voice keeps working; only calls holding private facts are protected.

## Scope and bounds

- The guard fires on `voiceStateUpdate` for a guild with an active bridge: it ignores the bot's own
  join/leave, recounts non-bot members in the bridged channel, and ends the call when
  `shouldHangUp` is true. A best-effort channel notice is posted; it is not an ephemeral interaction
  reply (there is no interaction in a gateway event).
- A call dropping to **zero** humans needs no hangup (no exposure); the existing idle/`AfterSilence`
  teardown covers it.
- This does **not** add consent/access-tier gating to voice recall (KNOWN-ISSUES #2). That gap is
  separate and remains open.

## Consequences

- A future architecture review will see a start-time memory snapshot with no live re-gate seam and may
  propose `setMemoryBlock`. That is recorded here as already-weighed: the live seam was rejected for its
  mid-turn race surface; the hangup is the deliberate, simpler enforcement.
- A late joiner ends the call for everyone, including the original single human — a deliberately blunt
  user experience traded for a zero-race privacy guarantee. If a softer experience is wanted later, the
  live-strip seam can be revisited, but it must address the in-flight-turn race this ADR avoids.
- The privacy invariant is now upheld by two pieces: the single-human snapshot at `/call` time, and the
  `voiceStateUpdate` circuit-breaker. Reviewers touching either must keep them consistent.
