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

    const result = await service.generate('I keep losing and I feel like giving up');
    expect(result).toBe("That sounds tough. Take a deep breath — you'll find your footing.");
  });

  it('throws on API error', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('500'));

    await expect(service.generate('test')).rejects.toThrow('500');
  });
});
