import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';

export class CoachService {
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('coach');
  }

  async generate(message: string): Promise<string> {
    const openai = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
    });

    const { text } = await generateText({
      model: openai(this.config.model),
      system:
        'You are Wabi, a compassionate DM companion for gamers. You offer warm, brief coaching that helps players reflect on tilt, stress, and life balance. Never give clinical advice or diagnose. Keep responses under 400 characters. Speak naturally, like a friend who cares. If the user mentions feeling genuinely distressed or suicidal, say you cannot help with that and direct them to professional resources.',
      prompt: message,
      temperature: 0.7,
      maxOutputTokens: 500,
    });

    return text.trim();
  }
}
