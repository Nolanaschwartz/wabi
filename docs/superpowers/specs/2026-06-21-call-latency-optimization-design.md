# Call latency optimization — design

**Date:** 2026-06-21
**Branch:** `wavi-caller-optimizations`
**Package:** `packages/call`
**Goal:** Reduce perceived latency in a Discord voice call — specifically *time from "user stops talking" → "first word heard"* — without regressing the recently-stabilized output/pacing path.

## Background

`packages/call` runs a Discord voice agent: Discord audio → turn detection → STT → LLM (streamed) → TTS → audio-sink → LiveKit → Discord. Time-to-first-word is ~4–6s today.

A five-angle investigation (input, LLM, TTS, output, architecture) located the latency budget. Findings, resolved against the actual source:

| Stage | Cost | Tunable in our code? | Notes |
|---|---|---|---|
| Turn-detect hangover (`voice-agent.service.ts:112`, `hangoverMs: 800`) | **800ms** forced wait | yes (one constant) | biggest single clean win |
| STT round-trip (serial, blocks LLM) | 500–1500ms | no | endpoint-bound |
| Wait for full sentence before 1st TTS (`takeSentences`, `voice-agent.service.ts:96`) | 200–500ms | yes (early-flush) | prosody risk — deferred |
| TTS first frame | ~600ms | no | endpoint-bound; streaming disabled (server distortion) |
| Inter-sentence synth gap (N+1 not synthesized while N plays) | ~600ms **per later sentence** | yes (prefetch) | anticipated by comment at `voice-agent.service.ts:241` |
| Output buffering (AudioSource 100ms + jitter TARGET 100ms) | ~200ms | yes | **out of scope** — just stabilized last night |

**Scope decision:** Measure first, then ship the low-risk code wins. The output-buffer trims and TTS-streaming re-enable are explicitly out of scope — they were the subject of the most recent commits (`41db4afc3`, `279ea88c0`, `15259b0b0`) and touching them re-opens the choppiness/distortion bugs just fixed.

## Ground-truth notes (verified in source)

- The producer/consumer split in `respond()` (`voice-agent.service.ts:242–291`) already runs the **LLM→sentence-text** producer ahead of playback. What does NOT overlap is **TTS synthesis**: the consumer loop synthesizes sentence N, plays it to completion, then calls `synthesizeStream` for N+1. The `~0.6s` TTS first-frame therefore lands as dead air at every sentence boundary. The code comment at line 241 explicitly defers this ("no synth-ahead overlap — add it only if seams sound off").
- `hangoverMs` lives in the `TURN_OPTS` const in `voice-agent.service.ts`, not in `turn-detector.ts`. `turn-detector.spec.ts` passes its own opts, so changing the const does not touch that spec.
- Barge-in (`voice-agent.service.ts:206–212`) sets `session.cancel`, calls `session.abort?.abort()`, and `session.sink.clear()`. Any prefetch change MUST preserve: in-flight synth for the prefetched sentence is aborted via the same `ctrl.signal`, and no buffered prefetch audio plays after a barge.

## Components

### 1. Per-stage instrumentation (build first)

**Why:** No per-stage timing exists today; all tuning below is blind without it. Avoids the manual temp-diagnostic churn from prior sessions.

**What:** In `respond()`, capture `Date.now()` at the existing natural seams and emit **one structured log line per turn** at the end (alongside or replacing the current `reply:` log):

```
latency stt=480ms llm_ttft=620ms sent1=120ms tts_first=590ms first_audio=1810ms total=3200ms
```

Stamps:
- `t0` — entry to `respond()` (utterance ready)
- `stt` — after `transcribe()` resolves (line ~228)
- `llm_ttft` — first LLM delta received (line ~253), measured from `t0`
- `sent1` — first sentence pushed to queue (line ~259), measured from first delta
- `tts_first` — first PCM frame reaches the sink (line ~286), measured from when its sentence was dequeued
- `first_audio` — `t0` → first PCM frame
- `total` — `t0` → reply settled (line ~305)

Always on at `Logger.log` level. No env flag (one line/turn is cheap). `Date.now()` is fine here (normal app code).

**Test:** assert the log line is emitted once per turn with the expected fields (can spy on the logger in `voice-agent.service.spec.ts`).

### 2. Hangover reduction

**What:** `hangoverMs: 800` → `400` in `TURN_OPTS` (`voice-agent.service.ts:112`). Update the adjacent comment to point at instrumentation's `total` as the tuning signal and note the ~250–300ms practical floor (below that it clips speakers who pause mid-thought).

**Risk:** Low. Independent of the output path. Worst case is premature cutoff, tunable back up.

**Test:** none needed beyond existing — it's a constant. `turn-detector.spec.ts` is unaffected (uses its own opts).

### 3. Synth prefetch, depth 1

**What:** Overlap sentence N+1's TTS synthesis with sentence N's playback (one sentence of lookahead). When the consumer begins playing sentence N, eagerly start `synthesizeStream` for N+1 and buffer its PCM frames in memory (~50–100KB/sentence) so its first audio is ready the moment N finishes. Closes the ~0.6s inter-sentence gap.

**Implementation constraints:**
- Preserve barge-in/abort exactly: a prefetched-but-not-yet-played sentence must be discarded (and its in-flight synth aborted via `ctrl.signal`) when `session.cancel || session.closed`.
- Preserve frame alignment: the `AudioSink` carries sub-frame remainders across writes and across sentences — prefetch must not break the ordering of writes to the sink.
- Preserve the fade-in: it applies only to the reply's very first PCM frame (`firstChunk`), not per sentence.
- Depth 1 only (one sentence ahead). Not a general N-deep pipeline — YAGNI.

**Test:** extend `voice-agent.service.spec.ts` — assert a multi-sentence reply synthesizes N+1 before N finishes playing, and that a barge mid-reply discards the prefetched sentence and plays no further audio.

## Deferred (data-gated, NOT built in this pass)

**First-sentence early-flush.** Flushing the first chunk at a clause boundary (`,;:—`) instead of waiting for `.!?` could save ~150–300ms on first-word, but risks choppy TTS prosody on fragmented openers. Decision rule: after shipping 1–3, read the instrumentation. Only build this if `llm_ttft + sent1` is a meaningful slice of `total`. If built, gate the flush on a minimum chunk length (~15 chars) and apply it only to the very first chunk of a turn.

## Out of scope (per scoping decision)

- Output-buffer trims (AudioSource queue 100→75ms, jitter `TARGET` 100→75ms) — recently stabilized; ~50ms gain not worth re-opening underrun risk.
- TTS streaming re-enable (`stream: true` in `openai-speech.ts`) — server-side distortion; endpoint-bound.
- Speculative LLM-before-STT execution — semantically dubious, high complexity.
- Memory-recall parallelization at call start — one-time setup cost, not per-turn.

## Expected outcome

~400ms off every turn (hangover) + ~0.6s per additional sentence (prefetch), with hard per-stage numbers from the instrumentation to guide any further tuning.

## Testing

`pnpm test` from `packages/call` must pass. New/updated specs: instrumentation log emission, prefetch overlap, prefetch barge-in discard. TDD: write the failing spec first per repo convention.
