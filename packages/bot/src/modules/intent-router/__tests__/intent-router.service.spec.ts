import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { IntentRouterService, type SpokeCatalogue } from '../intent-router.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => (model: any) => ({ _model: model })),
}));

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-router',
    apiKey: 'test-key',
  })),
}));

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
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.82}',
    });

    const result = await route('want to journal about tonight');

    expect(result).toEqual({ intent: 'journal', confidence: 0.82 });
  });

  it('parses the journal tool sub-intent when the model asks for a prompt (give_prompt)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.9,"tool":"give_prompt"}',
    });

    const result = await route('i need a journal entry prompt');

    expect(result).toEqual({ intent: 'journal', confidence: 0.9, tool: 'give_prompt' });
  });

  it('parses the journal tool sub-intent when the model writes an entry (save_entry)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.88,"tool":"save_entry"}',
    });

    const result = await route('journal: rough ranked night');

    expect(result).toEqual({ intent: 'journal', confidence: 0.88, tool: 'save_entry' });
  });

  it('parses the journal tool sub-intent when the model reads back an entry (get_entry)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.84,"tool":"get_entry"}',
    });

    const result = await route('what did i journal yesterday');

    expect(result).toEqual({ intent: 'journal', confidence: 0.84, tool: 'get_entry' });
  });

  it('parses a tool for a non-journal intent too (tools are uniform across spokes)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"mood","confidence":0.9,"tool":"log_mood"}',
    });

    const result = await route('log my mood');

    expect(result).toEqual({ intent: 'mood', confidence: 0.9, tool: 'log_mood' });
  });

  it('ignores an unknown tool value (verdict carries no tool)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.7,"tool":"frobnicate"}',
    });

    const result = await route('something');

    expect(result).toEqual({ intent: 'journal', confidence: 0.7 });
  });

  it('ignores a tool that belongs to a different intent (cross-intent tool dropped)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"coach","confidence":0.9,"tool":"give_prompt"}',
    });

    const result = await route('just venting');

    expect(result).toEqual({ intent: 'coach', confidence: 0.9 });
  });

  it('passes the confidence through verbatim', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"tilt","confidence":0.41}',
    });

    const result = await route('teammates keep feeding');

    expect(result.intent).toBe('tilt');
    expect(result.confidence).toBeCloseTo(0.41);
  });

  it('tolerates JSON wrapped in surrounding prose', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: 'Sure! {"intent":"mood","confidence":0.6} hope that helps',
    });

    const result = await route('feeling kind of low today');

    expect(result).toEqual({ intent: 'mood', confidence: 0.6 });
  });

  it('generates the system prompt from the catalogue — a new tool surfaces with no other edit', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"coach","confidence":0.9}' });
    const withNewTool: SpokeCatalogue = [
      ...CATALOGUE,
      {
        intent: 'mood',
        description: 'log how they feel',
        tools: [{ name: 'mood_history', description: 'show their recent mood trend' }],
      },
    ];

    await service.route('hey', withNewTool);

    const system = (generateText as jest.Mock).mock.calls[0][0].system as string;
    expect(system).toContain('"mood_history"');
    expect(system).toContain('show their recent mood trend');
    // Intent descriptions are generated too, not hand-maintained.
    expect(system).toContain('calm frustration');
  });

  it('resolves the provider lazily on every call (never cached at import)', async () => {
    const { getProvider } = jest.requireMock('@wabi/shared');
    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"coach","confidence":0.9}' });

    await route('hey');
    await route('hey again');

    // One resolve per call — config is re-read so a late-loaded ROUTER_* env is honoured.
    expect(getProvider).toHaveBeenCalledTimes(2);
    expect(getProvider).toHaveBeenCalledWith('router');
  });

  it('fails soft to coach/0 on an unknown intent label', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"billing","confidence":0.99}',
    });

    const result = await route('cancel my subscription');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on unparseable output', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'no json here' });

    const result = await route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 when confidence is missing or out of range', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"journal"}' });
    expect(await route('x')).toEqual({ intent: 'coach', confidence: 0 });

    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"journal","confidence":1.5}' });
    expect(await route('x')).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on a provider/network error (never throws)', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('network error'));

    const result = await route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });
});
