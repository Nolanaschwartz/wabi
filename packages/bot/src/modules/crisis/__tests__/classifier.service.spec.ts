import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ClassifierService } from '../classifier.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => (model: any) => ({ _model: model })),
}));

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-classifier',
    apiKey: 'test-key',
  })),
}));

describe('ClassifierService', () => {
  let service: ClassifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClassifierService();
  });

  it('classifies safe message', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    const result = await service.classify('just lost a match, feeling frustrated');
    expect(result).toBe('safe');
    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'test-key',
    });
  });

  it('classifies crisis message', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'crisis' });

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
  });

  it('defaults to crisis on API error (fail-safe)', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('network error'));

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
  });

  // Reasoning models (e.g. qwopus-3.6) sometimes return empty content (verdict lives in a separate
  // reasoning channel, or the budget is exhausted). Empty MUST fail safe to crisis — failing open to
  // 'safe' silently lets real crises through. Pairs with the larger output budget below, which makes
  // empty verdicts rare in the first place.
  it('treats empty model output as crisis (fail-safe, not fail-open)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '' });

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
  });

  it('treats blank/whitespace output as crisis (fail-safe)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '   \n ' });

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
  });

  it('treats unparseable response as crisis (fail-safe)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'probably fine' });

    const result = await service.classify('I had a rough day');
    expect(result).toBe('crisis');
  });

  it('returns safe only on an explicit safe verdict', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    const result = await service.classify('just lost a match');
    expect(result).toBe('safe');
  });

  // Reasoning models burn output tokens before emitting the verdict; a 10-token cap left content
  // empty for every message. The budget must be large enough for the model to finish reasoning and
  // still print "safe"/"crisis" (256 was the reliable floor against qwopus-3.6).
  it('requests an output budget large enough for reasoning models to emit a verdict', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    await service.classify('hello');

    const callArgs = (generateText as jest.Mock).mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBeGreaterThanOrEqual(256);
  });
});
