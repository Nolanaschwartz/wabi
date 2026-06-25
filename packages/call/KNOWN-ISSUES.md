# @wabi/call — known issues

Findings from the high-effort code review of the V0 voice-agent-memory work
(branch `worktree-voice-agent-memory`). Each was independently verified.
Unfixed by choice — tracked here so they aren't mistaken for "covered."

Severity: **HIGH** = privacy/safety, blocks merge to a real deployment ·
**MED** = correctness · **LOW** = cleanup.

## Merge blockers — privacy (these are the memory-feature code)

The single-human gate (ADR-0002/0017: inner-state data must never reach a
shared/social surface) is enforced only as a **snapshot at `/call` time**.
The temporal and consent dimensions are missing:

1. **[RESOLVED] Late joiner hears the first user's memory** — `src/discord/call.commands.ts`
   Closed by the late-joiner privacy circuit-breaker (issue 11, ADR-0043). A
   `voiceStateUpdate` handler now recounts humans in the bridged channel and, when
   a call that loaded memory gains a second human (`shouldHangUp`), ends the call
   via `bridge.stop` rather than mutating the live prompt. Memory-less calls are
   left running. The recall gate stays a start-time snapshot + this teardown guard.

2. **[HIGH] Recall ignores consent / access tier (ADR-0011)** — `src/agent/voice-memory.service.ts`
   `resolveUserId` checks only that a `User` row exists by `discordId` — not
   whether the user consented to memory or has active access. The bot gates
   recall behind `InnerStateConsentService.isEnabled`. A lapsed or
   never-consented user gets their derived inner-state spoken back. (PRD
   user-story 5 required this.)
   *Fix:* gate recall on active/consented access — reuse the bot's consent
   gate via `@wabi/shared` or an HTTP check before calling `recall()`.

3. **[HIGH] Second `/call` keeps the stale private prompt** — `src/agent/voice-agent.service.ts`
   `start()` early-returns on `sessions.has(roomName)`, discarding the freshly
   computed `memoryBlock`. Re-running `/call` after others join rebuilds the
   bridge but keeps the old session whose prompt still holds the private facts,
   even though the new call computed `''`. Compounds #1.
   *Fix:* refresh the session's system prompt on re-`start()`, or tear down
   and rebuild the agent session like the bridge does.

4. **[MED] Recall dumps the entire Mem0 corpus** — `src/agent/mem0.ts`
   `recall()` mirrors the bot's `getAllForUser` (`GET /memories`), the endpoint
   the bot reserves for **data-rights export/delete**. Coaching recall uses
   `POST /search` with a candidate limit. So every call seeds the prompt with
   all derived facts ever (stale/sensitive included) — larger disclosure blast
   radius + prompt bloat, no limit or timeout.
   *Fix:* switch to `POST /search` with a query and a candidate limit, as
   `MemoryStoreService.search` does.

## Inherited wabi-call code, landed as-is (real, pre-existing)

5. **[MED] `LivekitService` caches env in field initializers** — `src/livekit/livekit.service.ts:6`
   Reads `LIVEKIT_API_KEY/SECRET/URL` and builds the client at field-init —
   the exact lazy-config anti-pattern this repo forbids (see the comment in
   `src/app.module.ts`). If `LIVEKIT_*` isn't populated when Nest builds the
   singleton, `req()` throws in the initializer and the **whole app fails to
   boot** instead of degrading to "only `/call` fails."
   *Fix:* resolve env lazily inside `createToken()`, not in fields.

6. **[MED] Pipeline cached from the first call's env** — `src/agent/voice-agent.service.ts:60`
   `this.pipeline ??= createOpenAiPipeline(cfg)` freezes the first `/call`'s
   STT/LLM/TTS config for the process lifetime; later env changes are ignored.

7. **[RESOLVED] `parseWav` unbounded read** — TTS now streams raw PCM over the
   single WebSocket session (`synthesizeSession`), so the agent no longer parses
   TTS WAVs at all. `parseWav` was deleted with the dual-reply-path collapse
   (issue 09). No remaining caller.

8. **[MED] Bridge forwards all LiveKit participants unmixed** — `src/discord/bridge.service.ts:158`
   No allowlist restricting forwarding to the `assistant` identity; any
   participant joining `discord-<guildId>` is forwarded into the Discord
   channel, and two remote tracks garble playback.

9. **[RESOLVED] `openai-speech` reimplements `generate()`** — the per-request
   `synthesizeStream` path (`/v1/audio/speech`) was deleted with the dual-reply
   collapse (issue 09); the synth seam is now a single streaming session. The
   `respondStream` LLM call remains a deliberate streaming adapter (it needs SSE
   deltas the shared `generate()` doesn't expose); empty replies fail open in the
   turn loop.

10. **[LOW] Dead `RoomServiceClient`** — `src/livekit/livekit.service.ts:9`
    `rooms` field constructed at init, never referenced (only `createToken` is
    used, and it builds its own `AccessToken`). Delete it — also removes part
    of #5's eager env reads.

---

**Already fixed during the review:** the unauthenticated `POST /livekit/token`
endpoint (CRITICAL) was removed in commit `e824c2aef`.
