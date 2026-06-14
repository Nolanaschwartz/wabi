import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { CoachService } from '../coach.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => (model: any) => ({ _model: model })),
}));

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-coach',
    apiKey: 'test-key',
  })),
}));

describe('CoachService', () => {
  let service: CoachService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CoachService();
  });

  it('generates coaching reply', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: "That sounds tough. Take a deep breath — you'll find your footing.",
    });

    const result = await service.generate('system', 'I keep losing and I feel like giving up');
    expect(result).toBe("That sounds tough. Take a deep breath — you'll find your footing.");
  });

  it('returns empty string on API error', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('500'));

    const result = await service.generate('system', 'test');
    expect(result).toBe('');
  });

  it('retries on empty response with lower temperature', async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ text: '   ' })
      .mockResolvedValueOnce({ text: 'Retry works.' });

    const result = await service.generate('system', 'test');

    expect(result).toBe('Retry works.');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({ temperature: 0.3 }),
    );
  });

  it('returns empty after failed retry', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '' });

    const result = await service.generate('system', 'test');

    expect(result).toBe('');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('reports model id and token usage from the provider response (generateDetailed)', async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: 'hello',
      usage: { inputTokens: 12, outputTokens: 34 },
    });

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('hello');
    expect(result.model).toBe('test-coach');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it('sums token usage across the first attempt and the retry (no tokens lost)', async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ text: '   ', usage: { inputTokens: 50, outputTokens: 0 } })
      .mockResolvedValueOnce({ text: 'Retry works.', usage: { inputTokens: 30, outputTokens: 20 } });

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('Retry works.');
    // First attempt billed 50 input tokens before returning whitespace; those must not vanish.
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 20 });
  });

  it('reports the model id with usage absent when the provider omits token counts', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'hello' });

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('hello');
    expect(result.model).toBe('test-coach');
    expect(result.usage).toBeUndefined();
  });

  it('reports the model id even when generation fails (empty text, no usage)', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('500'));

    const result = await service.generateDetailed('system', 'test');

    expect(result.text).toBe('');
    expect(result.model).toBe('test-coach');
    expect(result.usage).toBeUndefined();
  });

  // The coach model (qwopus-3.6) is a reasoning model: a 500-token budget got truncated
  // mid-sentence and sometimes left content empty (all budget spent reasoning). Both the initial
  // attempt and the retry need enough room to finish reasoning and emit a full <400-char reply.
  it('requests a large enough output budget on every attempt', async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce({ text: 'ok' });

    await service.generate('system', 'test');

    for (const call of (generateText as jest.Mock).mock.calls) {
      expect(call[0].maxOutputTokens).toBeGreaterThanOrEqual(2048);
    }
  });
});
