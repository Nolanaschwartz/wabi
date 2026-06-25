# @wabi/call

A **NestJS 11** voice-call agent. It bridges a **Discord voice channel** straight to a real-time
**turn-detection → STT → LLM → TTS** loop so a person can *talk* to Wabi, with the same Mem0-backed
memory the DM coach uses.

It runs as its own HTTP process on **:3003** (`CALL_PORT`), loads the canonical root `.env`
(falling back from its own dir), and binds `0.0.0.0` so LAN clients can reach it.

> LiveKit was removed: the bridge now wires Discord audio directly to the agent. There is no
> `livekit/` module and no separate room.

## How a call works

```
/call slash command (necord)
  → join the Discord voice channel (@discordjs/voice), recall memory once at start
  → bridge: decode each speaker's Opus → mix → feed the agent's turn detector
  → agent: energy-based turn detection → STT → LLM (with recalled memory, streamed)
           → ONE streaming TTS session → PCM
  → playout: pace 24kHz mono PCM up to 48kHz stereo back into the Discord channel
  ... memory recalled per speaker via @wabi/shared mem0, keyed by Discord ID
```

Discord capture is 48kHz stereo; the agent downsamples to 16kHz mono for STT and the TTS server emits
24kHz mono, which `VoicePlayout` resamples to Discord's 48kHz stereo.

## Layout (`src/`)

- `main.ts` / `app.module.ts` — bootstrap; `ConfigModule.forRoot` loads `['.env', '../../.env']`.
- `discord/` — `bridge.service.ts` (joins the voice channel, decodes/mixes Opus in, paces PCM out),
  `call.commands.ts` (necord `/call`, `/tone`, `/hangup`), `speaker-mixer.ts` (mix simultaneous
  talkers), `voice-playout.ts` (the agent→Discord output pacer + drain signal).
- `agent/` — `voice-agent.service.ts` (the turn loop), `turn-detector.ts` + `vad.ts` (energy-based
  VAD, barge-in, pre-roll), `speech.ts` (the pipeline seam), `openai-speech.ts` (OpenAI-compatible
  adapters), `streaming-synth.ts` (the streaming-session TTS WebSocket protocol), `audio.util.ts`
  (WAV build + resample), `memory-context.ts` (`buildMemoryContext` — the single-human privacy gate),
  `voice-memory.service.ts` (Mem0 recall, keyed by Discord ID), `turn-timer.ts`, `agent.config.ts`.

The synth seam is a single method — `Synthesizer.synthesizeSession(text, signal)` — that streams the
LLM reply text into one continuous TTS session and reads one PCM stream back (no per-request seam).

## Commands

```bash
pnpm dev          # CALL_PORT=3003 nest start --watch (joins root `pnpm dev`)
pnpm start:prod   # node dist/main.js (built service)
pnpm test         # jest
pnpm build        # nest build
```

## Configuration (env)

Reads the root `.env`. Relevant vars: `CALL_PORT` (default 3003); the Discord login
`CALL_DISCORD_TOKEN` (distinct from the bot's token) and optional `CALL_DISCORD_DEV_GUILD`; and the
inference endpoints `STT_URL` / `LLM_URL` / `TTS_URL` (plus `*_MODEL`, `*_API_KEY`, `LLM_MAX_TOKENS`,
`TTS_VOICE`, `TTS_SPEED`, `AGENT_SYSTEM_PROMPT`). The streaming TTS WebSocket URL is derived from
`TTS_URL` + `/v1/audio/stream`.

Memory is read through `@wabi/shared` (the Mem0 client), keyed by **Discord ID** so a voice call and
the DM coach see the same derived memory, and only when exactly one human is present (the privacy
gate). See `../../docs/ARCHITECTURE.md`.
