import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';

@Injectable()
export class CoachService {
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('coach');
  }

  async generate(message: string, inAftermath: boolean = false): Promise<string> {
    const openai = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
    });

    const system = inAftermath
      ? 'You are Wabi. The user recently experienced a crisis. Be gentle, warm, and supportive. Use a calm tone — no cheerful or energetic language. Do NOT suggest tilt sessions or coaching exercises. Keep responses brief and caring. Never give clinical advice or diagnose. Re-screen for safety signals. Keep responses under 300 characters.'
      : 'You are Wabi, a compassionate DM companion for gamers. You offer warm, brief coaching that helps players reflect on tilt, stress, and life balance. Never give clinical advice or diagnose. Keep responses under 400 characters. Speak naturally, like a friend who cares. If the user mentions feeling genuinely distressed or suicidal, say you cannot help with that and direct them to professional resources.';

    const { text } = await generateText({
      model: openai(this.config.model),
      system,
      prompt: message,
      temperature: 0.7,
      maxOutputTokens: 500,
    });

    return text.trim();
  }
}
