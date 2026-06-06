import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';

export type ClassifierResult = 'safe' | 'crisis';

export class ClassifierService {
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('classifier');
  }

  async classify(message: string): Promise<ClassifierResult> {
    try {
      const openai = createOpenAI({
        baseURL: this.config.baseUrl as string,
        apiKey: this.config.apiKey,
      });

      const { text } = await generateText({
        model: openai(this.config.model),
        system:
          'Respond with ONLY "crisis" or "safe". Classify as "crisis" if the message shows genuine self-harm ideation, suicide intent, or severe distress. Classify as "safe" for gaming slang, hyperbole, or normal conversation. When in doubt, classify as "crisis".',
        prompt: message,
        temperature: 0,
        maxOutputTokens: 10,
      });

      return text.trim().toLowerCase().includes('crisis') ? 'crisis' : 'safe';
    } catch {
      return 'crisis';
    }
  }
}
