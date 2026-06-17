// coach is now a caller of @wabi/shared/generate: build {system, prompt} -> generate -> map result.
// The MECHANISM (lazy provider resolution, the ai client, the generateText call, retry-on-empty, and
// summing usage+latency across attempts) moved into generate; what stays here and is tested is coach's
// DOMAIN shaping — it OPTS IN to retryOnEmpty at the lower temperature — and its fail policy
// (transport throw / empty -> empty text), plus the CoachGeneration metadata it surfaces.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { CoachService } from '../coach.service';

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };

// generate returns { text, usage, model, latencyMs }; coach maps text/model/usage/latencyMs through.
const reply = (
  text: string,
  extra: { usage?: { inputTokens?: number; outputTokens?: number }; model?: string; latencyMs?: number } = {},
) => ({
  text,
  usage: extra.usage,
  model: extra.model ?? 'test-coach',
  latencyMs: extra.latencyMs ?? 0,
});

describe('CoachService', () => {
  let service: CoachService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CoachService();
  });

  it('generates coaching reply', async () => {
    generate.mockResolvedValue(reply("That sounds tough. Take a deep breath — you'll find your footing."));

    const result = await service.generate('system', 'I keep losing and I feel like giving up');
    expect(result).toBe("That sounds tough. Take a deep breath — you'll find your footing.");
  });

  it('calls generate with the coach role, system prompt, 2048 cap, temp 0.7 and retryOnEmpty at 0.3', async () => {
    generate.mockResolvedValue(reply('ok'));

    await service.generate('system text', 'prompt text');

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      'coach',
      expect.objectContaining({
        system: 'system text',
        prompt: 'prompt text',
        temperature: 0.7,
        maxOutputTokens: 2048,
        retryOnEmpty: { temperature: 0.3 },
      }),
    );
  });

  it('does not retry: generate owns retry-on-empty (single call even when the model returned empty)', async () => {
    // generate has already done any retry internally; coach calls it once regardless of outcome.
    generate.mockResolvedValue(reply('Retry works.'));

    const result = await service.generate('system', 'test');

    expect(result).toBe('Retry works.');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('returns empty string when generate throws on transport error', async () => {
    generate.mockRejectedValue(new Error('500'));

    const result = await service.generate('system', 'test');
    expect(result).toBe('');
  });

  it('returns empty string when generate returns empty text (after its own retry)', async () => {
    generate.mockResolvedValue(reply(''));

    const result = await service.generate('system', 'test');
    expect(result).toBe('');
  });

  it('reports model id, token usage and latency from generate (generateDetailed)', async () => {
    generate.mockResolvedValue(
      reply('hello', { usage: { inputTokens: 12, outputTokens: 34 }, model: 'test-coach', latencyMs: 42 }),
    );

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('hello');
    expect(result.model).toBe('test-coach');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(result.latencyMs).toBe(42);
  });

  it('surfaces usage and latency summed across both attempts when generate retried', async () => {
    // generate sums the first attempt's billed tokens + retry tokens, and the latency of both, before
    // returning. coach reflects those summed values straight through (it no longer does any summing).
    generate.mockResolvedValue(
      reply('Retry works.', { usage: { inputTokens: 80, outputTokens: 20 }, latencyMs: 130 }),
    );

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('Retry works.');
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 20 });
    expect(result.latencyMs).toBe(130);
  });

  it('reports the model id with usage absent when generate omits token counts', async () => {
    generate.mockResolvedValue(reply('hello', { usage: undefined, model: 'test-coach' }));

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('hello');
    expect(result.model).toBe('test-coach');
    expect(result.usage).toBeUndefined();
  });

  it('yields empty text with no usage when generate throws (fail policy unchanged)', async () => {
    // generate throws before it can resolve a model; coach no longer caches the provider, so the
    // failed-turn generation carries no model/usage. Fail policy is what matters: empty text.
    generate.mockRejectedValue(new Error('500'));

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('');
    expect(result.usage).toBeUndefined();
  });

  it('requests a 2048 output budget (large enough for the reasoning model on every attempt)', async () => {
    generate.mockResolvedValue(reply('ok'));

    await service.generate('system', 'test');

    expect(generate).toHaveBeenCalledWith('coach', expect.objectContaining({ maxOutputTokens: 2048 }));
  });
});
