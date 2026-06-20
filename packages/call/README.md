# @wabi/call

A **NestJS 11** voice-call agent. It bridges a **Discord voice channel** to a **LiveKit room**
and runs a real-time **turn-detection → STT → LLM → TTS** loop so a person can *talk* to Wabi,
with the same Mem0-backed memory the DM coach uses.

It runs as its own HTTP process on **:3003** (`CALL_PORT`), loads the canonical root `.env`
(falling back from its own dir), and binds `0.0.0.0` so LAN clients can reach it.

## How a call works

```
/call slash command (necord)
  → join the Discord voice channel (@discordjs/voice)  ∥  join/mint a LiveKit room (livekit-server-sdk)
  → bridge: pipe Opus audio both ways at 48kHz (no resampling)
  → agent: energy-based turn detection → STT → LLM (with recalled memory) → TTS → publish reply
  ... memory recalled per speaker via @wabi/shared mem0, keyed by Discord ID
```

Audio stays at 48kHz end to end (Discord voice and the LiveKit track run at the same rate), so
the bridge moves Opus frames without resampling.

## Layout (`src/`)

- `main.ts` / `app.module.ts` — bootstrap; `ConfigModule.forRoot` loads `['.env', '../../.env']`.
- `livekit/` — `LivekitService`: mints room join tokens and talks to `RoomServiceClient`
  (rooms auto-create on first join).
- `discord/` — `bridge.service.ts` (joins the Discord voice channel and pipes Opus ↔ LiveKit
  room), `call.commands.ts` (necord slash commands), `speaker-mixer.ts`.
- `agent/` — `voice-agent.service.ts` (the LiveKit room agent), `turn-detector.ts`
  (energy-based VAD), `speech.ts` / `openai-speech.ts` (the STT→LLM→TTS pipeline),
  `audio-sink.ts` + `audio.util.ts` (WAV build/parse, resample), `memory-context.ts`
  (`composeSystemPrompt`), `voice-memory.service.ts` (Mem0 recall, keyed by Discord ID to
  share the bot's memory partition), `agent.config.ts`.

## Commands

```bash
pnpm dev          # CALL_PORT=3003 nest start --watch (joins root `pnpm dev`)
pnpm start:prod   # node dist/main.js (built service)
pnpm test         # jest
pnpm build        # nest build
```

## Configuration (env)

Reads the root `.env`. Relevant vars: `CALL_PORT` (default 3003), the **LiveKit** credentials
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, the Discord token shared with the
bot, and the `coach` inference provider (via `@wabi/shared`) for the speech LLM.

Memory is read through `@wabi/shared` (the Mem0 client), keyed by **Discord ID** so a voice
call and the DM coach see the same derived memory. See `../../docs/ARCHITECTURE.md`.
