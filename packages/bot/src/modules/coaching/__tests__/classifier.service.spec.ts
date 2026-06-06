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

  it('treats ambiguous response as safe', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'probably fine' });

    const result = await service.classify('I had a rough day');
    expect(result).toBe('safe');
  });
});
