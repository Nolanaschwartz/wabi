import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { IntentRouterService } from '../intent-router.service';

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

describe('IntentRouterService', () => {
  let service: IntentRouterService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntentRouterService();
  });

  it('parses a wellness-verb intent and confidence from the model', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.82}',
    });

    const result = await service.route('want to journal about tonight');

    expect(result).toEqual({ intent: 'journal', confidence: 0.82 });
  });

  it('parses the journal tool sub-intent when the model asks for a prompt (give_prompt)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.9,"tool":"give_prompt"}',
    });

    const result = await service.route('i need a journal entry prompt');

    expect(result).toEqual({ intent: 'journal', confidence: 0.9, tool: 'give_prompt' });
  });

  it('parses the journal tool sub-intent when the model writes an entry (save_entry)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.88,"tool":"save_entry"}',
    });

    const result = await service.route('journal: rough ranked night');

    expect(result).toEqual({ intent: 'journal', confidence: 0.88, tool: 'save_entry' });
  });

  it('parses the journal tool sub-intent when the model reads back an entry (get_entry)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.84,"tool":"get_entry"}',
    });

    const result = await service.route('what did i journal yesterday');

    expect(result).toEqual({ intent: 'journal', confidence: 0.84, tool: 'get_entry' });
  });

  it('ignores an unknown tool value (verdict carries no tool)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"journal","confidence":0.7,"tool":"frobnicate"}',
    });

    const result = await service.route('something');

    expect(result).toEqual({ intent: 'journal', confidence: 0.7 });
  });

  it('ignores a tool on a non-journal intent (tool is journal-only)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"coach","confidence":0.9,"tool":"give_prompt"}',
    });

    const result = await service.route('just venting');

    expect(result).toEqual({ intent: 'coach', confidence: 0.9 });
  });

  it('passes the confidence through verbatim', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"tilt","confidence":0.41}',
    });

    const result = await service.route('teammates keep feeding');

    expect(result.intent).toBe('tilt');
    expect(result.confidence).toBeCloseTo(0.41);
  });

  it('tolerates JSON wrapped in surrounding prose', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: 'Sure! {"intent":"mood","confidence":0.6} hope that helps',
    });

    const result = await service.route('feeling kind of low today');

    expect(result).toEqual({ intent: 'mood', confidence: 0.6 });
  });

  it('resolves the provider lazily on every call (never cached at import)', async () => {
    const { getProvider } = jest.requireMock('@wabi/shared');
    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"coach","confidence":0.9}' });

    await service.route('hey');
    await service.route('hey again');

    // One resolve per call — config is re-read so a late-loaded ROUTER_* env is honoured.
    expect(getProvider).toHaveBeenCalledTimes(2);
    expect(getProvider).toHaveBeenCalledWith('router');
  });

  it('fails soft to coach/0 on an unknown intent label', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: '{"intent":"billing","confidence":0.99}',
    });

    const result = await service.route('cancel my subscription');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on unparseable output', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'no json here' });

    const result = await service.route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 when confidence is missing or out of range', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"journal"}' });
    expect(await service.route('x')).toEqual({ intent: 'coach', confidence: 0 });

    (generateText as jest.Mock).mockResolvedValue({ text: '{"intent":"journal","confidence":1.5}' });
    expect(await service.route('x')).toEqual({ intent: 'coach', confidence: 0 });
  });

  it('fails soft to coach/0 on a provider/network error (never throws)', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('network error'));

    const result = await service.route('anything');

    expect(result).toEqual({ intent: 'coach', confidence: 0 });
  });
});
