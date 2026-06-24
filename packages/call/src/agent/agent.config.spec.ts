import { loadAgentConfig } from './agent.config';

// loadAgentConfig re-reads process.env on every call by design (lazy config, see CLAUDE.md
// "Resolve config lazily"). These tests prove the new caps/pacing knobs honour that and the
// documented defaults — never an import-time freeze.

const REQUIRED = {
  STT_URL: 'http://stt',
  LLM_URL: 'http://llm',
  TTS_URL: 'http://tts',
};

describe('loadAgentConfig — output cap + pacing knobs', () => {
  const saved = process.env;

  beforeEach(() => {
    process.env = { ...REQUIRED } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = saved;
  });

  it('defaults llm.maxTokens to a generous backstop (large so a reasoning model still emits text)', () => {
    expect(loadAgentConfig().llm.maxTokens).toBe(2048);
    expect(loadAgentConfig().llm.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('reads LLM_MAX_TOKENS as a number when set', () => {
    process.env.LLM_MAX_TOKENS = '256';
    expect(loadAgentConfig().llm.maxTokens).toBe(256);
  });

  it('defaults tts.speed to a brisk 1.1', () => {
    expect(loadAgentConfig().tts.speed).toBe(1.1);
  });

  it('reads TTS_SPEED as a number when set', () => {
    process.env.TTS_SPEED = '1.25';
    expect(loadAgentConfig().tts.speed).toBe(1.25);
  });

  it('resolves lazily: a change between calls is reflected, never cached at import', () => {
    expect(loadAgentConfig().llm.maxTokens).toBe(2048);
    process.env.LLM_MAX_TOKENS = '200';
    process.env.TTS_SPEED = '0.9';
    expect(loadAgentConfig().llm.maxTokens).toBe(200);
    expect(loadAgentConfig().tts.speed).toBe(0.9);
  });
});
