import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAgentConfig } from '../src/agent/agent.config';
import { createOpenAiPipeline } from '../src/agent/openai-speech';

// End-to-end against the REAL TTS server (the configured TTS_URL). Validates the streaming synth path
// produces correct-length audio — i.e. the server-side over-generation that dragged short replies
// (synth_audio 2–5x the natural length, traced to a missing repetition penalty in stream_generate_pcm)
// is fixed. Run: `pnpm -F call test:e2e` with the root .env present (or TTS_URL exported).

// The TTS server emits 24kHz mono PCM (kept in sync with the bridge's TTS_RATE).
const SYNTH_RATE = 24000;
// Natural speech is ~13–16 chars/sec. Residual over-generation shows as ~8–9 chars/sec (audibly slow,
// worst on short replies). Require at least 10 chars/sec (~120 wpm) — passes a natural/calm voice, fails
// the stretch. Raise toward 12 if a fixed voice still trips it; lower only if a legit slow voice is wanted.
const MIN_CHARS_PER_SEC = 10;
// And not absurdly fast/truncated (natural max ~17/sec); catches empty or cut-off output.
const MAX_CHARS_PER_SEC = 40;

// Best-effort: pull TTS_* from the repo-root .env if not already in the environment (no dotenv dep).
function loadRootEnv(): void {
  if (process.env.TTS_URL) return;
  const envPath = path.resolve(__dirname, '../../../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadRootEnv();

// Skip (don't fail) when there's no TTS endpoint configured — keeps CI green without the server.
const describeIfTts = process.env.TTS_URL ? describe : describe.skip;

describeIfTts('TTS server (e2e) — streaming synth produces correct-length audio', () => {
  const synth = createOpenAiPipeline(loadAgentConfig()).synthesizer;

  // Length-meaningful phrases (short ones where the bug was worst, plus a longer one for no-timeout/continuity).
  const phrases = [
    "I'm doing well, thanks for asking.",
    "Hey, what's going on with you today?",
    'Sure, I can help with that. Let me know what is on your mind and we will work through it together.',
  ];

  it.each(phrases)(
    'synthesizes %j at a natural rate (no over-generation)',
    async (text) => {
      let samples = 0;
      for await (const pcm of synth.synthesizeStream(text)) {
        samples += pcm.length;
      }
      const audioSec = samples / SYNTH_RATE;
      const charsPerSec = text.length / audioSec;
      // Visible in test output so a regression's actual rate is obvious.
      // eslint-disable-next-line no-console
      console.log(
        `chars=${text.length} audio=${audioSec.toFixed(2)}s rate=${charsPerSec.toFixed(1)} chars/s`,
      );

      expect(audioSec).toBeGreaterThan(0.3); // got real audio, not empty
      expect(charsPerSec).toBeGreaterThanOrEqual(MIN_CHARS_PER_SEC); // not stretched/over-generated
      expect(charsPerSec).toBeLessThanOrEqual(MAX_CHARS_PER_SEC); // not truncated
    },
    60_000, // network synth; generous per-phrase timeout
  );
});
