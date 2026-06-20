// Loaded lazily on first /call so the app boots without these set.
export interface AgentConfig {
  stt: { url: string; model: string; key?: string };
  llm: { url: string; model: string; key?: string };
  tts: { url: string; model: string; voice: string; key?: string };
  systemPrompt: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v.replace(/\/+$/, ''); // trim trailing slash; we append /v1/...
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
    },
    tts: {
      url: req('TTS_URL'),
      model: process.env.TTS_MODEL ?? 'tts-1',
      voice: process.env.TTS_VOICE ?? 'alloy',
      key: process.env.TTS_API_KEY,
    },
    systemPrompt:
      process.env.AGENT_SYSTEM_PROMPT ??
      'You are a helpful voice assistant on a call. Keep replies short and conversational.',
  };
}

export function authHeader(key?: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}
