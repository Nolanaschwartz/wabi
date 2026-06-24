// Loaded lazily on first /call so the app boots without these set.
export interface AgentConfig {
  stt: { url: string; model: string; key?: string };
  // maxTokens is a runaway BACKSTOP (the brevity prompt controls length). Must stay generous: this is a
  // reasoning model, and a tight cap starves the visible reply to empty.
  llm: { url: string; model: string; key?: string; maxTokens: number };
  // speed paces the synthesized voice (1.0 = native). The TTS server is single-stream.
  tts: { url: string; model: string; voice: string; key?: string; speed: number };
  systemPrompt: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v.replace(/\/+$/, ''); // trim trailing slash; we append /v1/...
}

// Numeric env knob with a default. Falls back when unset or unparseable, so a typo
// never hands the request body a NaN.
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadAgentConfig(): AgentConfig {
  return {
    stt: {
      url: req('STT_URL'),
      model: process.env.STT_MODEL ?? 'whisper-1',
      key: process.env.STT_API_KEY,
    },
    llm: {
      url: req('LLM_URL'),
      model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
      key: process.env.LLM_API_KEY,
      // Runaway BACKSTOP, not the length control. This LLM is a reasoning model: it spends hidden
      // reasoning tokens before any visible text, so a tight cap (160 was tried) starves the content
      // and the reply comes back EMPTY (see "reasoning-model output caps"). Keep this generous so the
      // model always produces text; the brevity system prompt is what keeps replies short. Raise via
      // LLM_MAX_TOKENS if replies ever return empty (reasoning budget exceeded).
      maxTokens: numEnv('LLM_MAX_TOKENS', 2048),
    },
    tts: {
      url: req('TTS_URL'),
      model: process.env.TTS_MODEL ?? 'tts-1',
      voice: process.env.TTS_VOICE ?? 'alloy',
      key: process.env.TTS_API_KEY,
      // Slightly brisk by default; tune with TTS_SPEED. Server is single-stream.
      speed: numEnv('TTS_SPEED', 1.1),
    },
    systemPrompt:
      process.env.AGENT_SYSTEM_PROMPT ??
      'You are a voice assistant on a live call. Reply in at most 1-2 short, ' +
        'conversational sentences. Never monologue, never list, never give long ' +
        'explanations — say the single most useful thing and stop. If more is ' +
        'needed, let them ask.',
  };
}

export function authHeader(key?: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}
