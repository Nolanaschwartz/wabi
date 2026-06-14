import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';
import { compactUsage } from '../../lib/usage';

/**
 * The coach model's reply plus the cost/identity signal for the generation: which model produced it
 * and how many tokens it used. `usage` is present only when the provider reports it — never fabricated.
 */
export interface CoachGeneration {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

@Injectable()
export class CoachService {
  private readonly logger = new JsonLogger(CoachService.name);
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('coach');
  }

  /**
   * Run the coach model against an already-assembled {system, prompt} and return only the reply text.
   * Thin wrapper over generateDetailed for callers that don't need the generation metadata.
   */
  async generate(system: string, prompt: string): Promise<string> {
    return (await this.generateDetailed(system, prompt)).text;
  }

  /**
   * Run the coach model and return the reply alongside its model id and token usage. This service is
   * the model adapter only — retries, output budget, error-to-empty-string. All prompt shaping
   * (persona selection, context layout, aftermath tone) lives in buildCoachPrompt (coach-prompt.ts).
   */
  async generateDetailed(system: string, prompt: string): Promise<CoachGeneration> {
    const openai = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
    });

    try {
      const first = await generateText({
        model: openai(this.config.model),
        system,
        prompt,
        temperature: 0.7,
        maxOutputTokens: 2048,
      });

      let result = first.text.trim();
      // Accumulate usage across every attempt: the first call can burn tokens then return whitespace,
      // and dropping its usage on retry under-counts the turn's real (and billed) cost.
      const usageParts: (TokenUsage | undefined)[] = [first.usage];
      if (!result) {
        this.logger.warn('coach returned empty response, retrying', {
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          contextLength: prompt.length,
        });

        const retry = await generateText({
          model: openai(this.config.model),
          system,
          prompt,
          temperature: 0.3,
          maxOutputTokens: 2048,
        });
        result = retry.text.trim();
        usageParts.push(retry.usage);
      }
      if (!result) {
        this.logger.warn('coach returned empty response after retry', {
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          contextLength: prompt.length,
        });
      }
      return { text: result, model: this.config.model, usage: sumUsage(usageParts) };
    } catch (err) {
      this.logger.error('coach generate failed', {
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        error: err instanceof Error ? err.message : String(err),
        contextLength: prompt.length,
      });
      return { text: '', model: this.config.model };
    }
  }
}

type TokenUsage = { inputTokens?: number; outputTokens?: number };

// Sum the token counts across every generate attempt, then drop any that no attempt reported. A count
// of 0 is real and kept; a field no attempt returned stays absent (never coerced to zero).
function sumUsage(parts: (TokenUsage | undefined)[]): TokenUsage | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const part of parts) {
    if (part && typeof part.inputTokens === 'number') inputTokens = (inputTokens ?? 0) + part.inputTokens;
    if (part && typeof part.outputTokens === 'number') outputTokens = (outputTokens ?? 0) + part.outputTokens;
  }
  return compactUsage({ inputTokens, outputTokens }, { input: 'inputTokens', output: 'outputTokens' }) as
    | TokenUsage
    | undefined;
}
