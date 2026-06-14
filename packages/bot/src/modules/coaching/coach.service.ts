import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

@Injectable()
export class CoachService {
  private readonly logger = new JsonLogger(CoachService.name);
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('coach');
  }

  /**
   * Run the coach model against an already-assembled {system, prompt}. This service is the model
   * adapter only — retries, output budget, error-to-empty-string. All prompt shaping (persona
   * selection, context layout, aftermath tone) lives in buildCoachPrompt (coach-prompt.ts).
   */
  async generate(system: string, prompt: string): Promise<string> {
    const openai = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
    });

    try {
      const { text } = await generateText({
        model: openai(this.config.model),
        system,
        prompt,
        temperature: 0.7,
        maxOutputTokens: 2048,
      });

      let result = text.trim();
      if (!result) {
        this.logger.warn('coach returned empty response, retrying', {
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          contextLength: prompt.length,
        });

        const { text: retryText } = await generateText({
          model: openai(this.config.model),
          system,
          prompt,
          temperature: 0.3,
          maxOutputTokens: 2048,
        });
        result = retryText.trim();
      }
      if (!result) {
        this.logger.warn('coach returned empty response after retry', {
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          contextLength: prompt.length,
        });
      }
      return result;
    } catch (err) {
      this.logger.error('coach generate failed', {
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        error: err instanceof Error ? err.message : String(err),
        contextLength: prompt.length,
      });
      return '';
    }
  }
}
