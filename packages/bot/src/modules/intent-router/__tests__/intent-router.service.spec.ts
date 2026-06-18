// The router is now a caller of @wabi/shared/generate: it builds its catalogue system prompt, calls
// generate('router', …), then keeps its DOMAIN logic — the JSON parse and catalogue validation — and
// its local fail-SOFT policy (any transport throw, empty output, unparseable JSON, unknown label, or
// out-of-range confidence resolves to coach/0). The MECHANISM (provider resolution, ai client, the
// call, lazy re-read of env) now lives in generate, so it is no longer asserted here.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { IntentRouterService, type SpokeCatalogue } from '../intent-router.service';

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };

// generate returns { text, usage?, model, latencyMs }; the router reads only text.
const reply = (text: string) => ({ text, model: 'test-router', latencyMs: 1 });

// The catalogue the hub passes in — the single source the router prompts from and validates against.
const CATALOGUE: SpokeCatalogue = [
  { intent: 'coach', description: 'anything else', tools: [{ name: 'coach', description: 'talk it through' }] },
  {
    intent: 'journal',
    description: 'write or reflect',
    tools: [
      { name: 'give_prompt', description: 'offer a prompt' },
      { name: 'save_entry', description: 'save the entry' },
      { name: 'get_entry', description: 'read it back' },
    ],
  },
  { intent: 'tilt', description: 'calm frustration', tools: [{ name: 'offer_session', description: 'offer a session' }] },
  { intent: 'mood', description: 'log how they feel', tools: [{ name: 'log_mood', description: 'log a 1-5' }] },
];

describe('IntentRouterService', () => {
  let service: IntentRouterService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntentRouterService();
  });

  const route = (batch: string) => service.route(batch, CATALOGUE);

  it('parses a wellness-verb intent and confidence from the model', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.82}'));

    const result = await route('want to journal about tonight');

    expect(result).toEqual({ intent: 'journal', confidence: 0.82 });
  });

  // The verdict return is unchanged; model + usage are reported out-of-band through an optional sink so
  // the hub can stamp them on the manual `intent` span without polluting IntentResult.
  it('reports model + usage to the optional telemetry sink on a successful route', async () => {
    generate.mockResolvedValue({
      text: '{"intent":"coach","confidence":0.5}',
      usage: { inputTokens: 30, outputTokens: 4 },
      model: 'qwopus',
      latencyMs: 1,
    });
    const onTelemetry = jest.fn();

    await service.route('whatever', CATALOGUE, undefined, onTelemetry);

    expect(onTelemetry).toHaveBeenCalledWith({ model: 'qwopus', usage: { inputTokens: 30, outputTokens: 4 } });
  });

  it('does NOT call the telemetry sink when the route call throws (fail-soft, no model)', async () => {
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    generate.mockRejectedValue(new Error('boom'));
    const onTelemetry = jest.fn();

    const result = await service.route('whatever', CATALOGUE, undefined, onTelemetry);

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
    expect(onTelemetry).not.toHaveBeenCalled();
  });

  it('parses the journal tool sub-intent when the model asks for a prompt (give_prompt)', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.9,"tool":"give_prompt"}'));

    const result = await route('i need a journal entry prompt');

    expect(result).toEqual({ intent: 'journal', confidence: 0.9, tool: 'give_prompt' });
  });

  it('parses the journal tool sub-intent when the model writes an entry (save_entry)', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.88,"tool":"save_entry"}'));

    const result = await route('journal: rough ranked night');

    expect(result).toEqual({ intent: 'journal', confidence: 0.88, tool: 'save_entry' });
  });

  it('parses the journal tool sub-intent when the model reads back an entry (get_entry)', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.84,"tool":"get_entry"}'));

    const result = await route('what did i journal yesterday');

    expect(result).toEqual({ intent: 'journal', confidence: 0.84, tool: 'get_entry' });
  });

  it('parses a tool for a non-journal intent too (tools are uniform across spokes)', async () => {
    generate.mockResolvedValue(reply('{"intent":"mood","confidence":0.9,"tool":"log_mood"}'));

    const result = await route('log my mood');

    expect(result).toEqual({ intent: 'mood', confidence: 0.9, tool: 'log_mood' });
  });

  it('ignores an unknown tool value (verdict carries no tool)', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.7,"tool":"frobnicate"}'));

    const result = await route('something');

    expect(result).toEqual({ intent: 'journal', confidence: 0.7 });
  });

  it('ignores a tool that belongs to a different intent (cross-intent tool dropped)', async () => {
    generate.mockResolvedValue(reply('{"intent":"coach","confidence":0.9,"tool":"give_prompt"}'));

    const result = await route('just venting');

    expect(result).toEqual({ intent: 'coach', confidence: 0.9 });
  });

  it('passes the confidence through verbatim', async () => {
    generate.mockResolvedValue(reply('{"intent":"tilt","confidence":0.41}'));

    const result = await route('teammates keep feeding');

    expect(result.intent).toBe('tilt');
    expect(result.confidence).toBeCloseTo(0.41);
  });

  it('tolerates JSON wrapped in surrounding prose', async () => {
    generate.mockResolvedValue(reply('Sure! {"intent":"mood","confidence":0.6} hope that helps'));

    const result = await route('feeling kind of low today');

    expect(result).toEqual({ intent: 'mood', confidence: 0.6 });
  });

  it('generates the system prompt from the catalogue — a new tool surfaces with no other edit', async () => {
    generate.mockResolvedValue(reply('{"intent":"coach","confidence":0.9}'));
    const withNewTool: SpokeCatalogue = [
      ...CATALOGUE,
      {
        intent: 'mood',
        description: 'log how they feel',
        tools: [{ name: 'mood_history', description: 'show their recent mood trend' }],
      },
    ];

    await service.route('hey', withNewTool);

    const system = generate.mock.calls[0][1].system as string;
    expect(system).toContain('"mood_history"');
    expect(system).toContain('show their recent mood trend');
    // Intent descriptions are generated too, not hand-maintained.
    expect(system).toContain('calm frustration');
  });

  it('calls generate with role "router", temperature 0, the 256 cap, and no retry-on-empty', async () => {
    generate.mockResolvedValue(reply('{"intent":"coach","confidence":0.9}'));

    await route('hey');

    expect(generate.mock.calls[0][0]).toBe('router');
    const opts = generate.mock.calls[0][1];
    expect(opts.temperature).toBe(0);
    expect(opts.maxOutputTokens).toBe(256);
    expect(opts.retryOnEmpty).toBeUndefined();
    expect(typeof opts.system).toBe('string');
    expect(typeof opts.prompt).toBe('string');
  });

  // Tool ARGUMENTS — the router extracts log_mood's rating so the mood spoke can log in one shot.
  // parse() is the trust boundary: the LLM number is clamped (integer, 1–5) before it can reach the DB.
  it('extracts args.rating for a valid 1–5 on log_mood', async () => {
    generate.mockResolvedValue(reply('{"intent":"mood","confidence":0.95,"tool":"log_mood","args":{"rating":4}}'));

    const result = await route('set my mood to four');

    expect(result).toEqual({ intent: 'mood', confidence: 0.95, tool: 'log_mood', args: { rating: 4 } });
  });

  it.each([
    ['0 (below range)', '{"intent":"mood","confidence":0.9,"tool":"log_mood","args":{"rating":0}}'],
    ['6 (above range)', '{"intent":"mood","confidence":0.9,"tool":"log_mood","args":{"rating":6}}'],
    ['2.5 (non-integer)', '{"intent":"mood","confidence":0.9,"tool":"log_mood","args":{"rating":2.5}}'],
    ['"4" (string, not number)', '{"intent":"mood","confidence":0.9,"tool":"log_mood","args":{"rating":"4"}}'],
    ['malformed args (no rating)', '{"intent":"mood","confidence":0.9,"tool":"log_mood","args":{"foo":1}}'],
  ])('drops the rating when it is %s', async (_label, json) => {
    generate.mockResolvedValue(reply(json));

    const result = await route('mood thing');

    expect(result).toEqual({ intent: 'mood', confidence: 0.9, tool: 'log_mood' });
  });

  it('ignores args entirely when the chosen tool is not log_mood', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal","confidence":0.9,"tool":"save_entry","args":{"rating":4}}'));

    const result = await route('journal: had a 4 kind of day');

    expect(result).toEqual({ intent: 'journal', confidence: 0.9, tool: 'save_entry' });
  });

  it('includes the log_mood args instruction in the generated system prompt', async () => {
    generate.mockResolvedValue(reply('{"intent":"coach","confidence":0.9}'));

    await route('hey');

    const system = generate.mock.calls[0][1].system as string;
    expect(system).toMatch(/log_mood/);
    expect(system).toMatch(/rating/);
  });

  it('fails soft to coach/0 on an unknown intent label', async () => {
    generate.mockResolvedValue(reply('{"intent":"billing","confidence":0.99}'));

    const result = await route('cancel my subscription');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on unparseable output', async () => {
    generate.mockResolvedValue(reply('no json here'));

    const result = await route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on empty output (an empty text flows through the unparseable branch)', async () => {
    generate.mockResolvedValue(reply(''));

    const result = await route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 when confidence is missing or out of range', async () => {
    generate.mockResolvedValue(reply('{"intent":"journal"}'));
    expect(await route('x')).toEqual({ intent: 'coach', confidence: 0 });

    generate.mockResolvedValue(reply('{"intent":"journal","confidence":1.5}'));
    expect(await route('x')).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on a transport error from generate (never throws)', async () => {
    generate.mockRejectedValue(new Error('network error'));

    const result = await route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });
});
