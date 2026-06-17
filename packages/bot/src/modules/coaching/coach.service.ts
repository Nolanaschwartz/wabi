import { Injectable } from '@nestjs/common';
import { generate, type GenerateTelemetry } from '@wabi/shared/generate';
import { JsonLogger } from '../../lib/json-logger';

/**
 * The coach model's reply plus the cost/identity signal for the generation: which model produced it,
 * how many tokens it used, and how long it took. `usage` is present only when the provider reports it
 * — never fabricated. `latencyMs` is summed across attempts by generate and carried for span timing.
 */
export interface CoachGeneration {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
}

@Injectable()
export class CoachService {
  private readonly logger = new JsonLogger(CoachService.name);

  /**
   * Run the coach model against an already-assembled {system, prompt} and return only the reply text.
   * Thin wrapper over generateDetailed for callers that don't need the generation metadata.
   */
  async generate(system: string, prompt: string): Promise<string> {
    return (await this.generateDetailed(system, prompt)).text;
  }

  /**
   * Run the coach model and return the reply alongside its model id, token usage, and latency. The
   * mechanism — lazy provider resolution, the client, the call, retry-on-empty, summing usage+latency
   * across attempts — lives in @wabi/shared/generate. This service keeps only coach's shaping (it OPTS
   * IN to retryOnEmpty: a blank reply gets one second attempt at the lower temperature) and its fail
   * policy (a thrown/empty call yields empty text). All prompt shaping (persona selection, context
   * layout, aftermath tone) lives in buildCoachPrompt (coach-prompt.ts).
   */
  async generateDetailed(
    system: string,
    prompt: string,
    telemetry?: GenerateTelemetry,
  ): Promise<CoachGeneration> {
    try {
      const out = await generate('coach', {
        system,
        prompt,
        temperature: 0.7,
        maxOutputTokens: 2048,
        retryOnEmpty: { temperature: 0.3 },
        // Below the crisis gate: the AI SDK auto-captures model/usage/latency (and prompt+reply when
        // recordInputs/Outputs are set) to the isolated Langfuse tracer. Above-gate callers omit this.
        telemetry,
        log: ({ model, baseUrl, cap }) =>
          this.logger.warn('coach returned empty response after retry', {
            model,
            baseUrl,
            cap,
            contextLength: prompt.length,
          }),
      });
      return { text: out.text, model: out.model, usage: out.usage, latencyMs: out.latencyMs };
    } catch (err) {
      this.logger.error('coach generate failed', {
        error: err instanceof Error ? err.message : String(err),
        contextLength: prompt.length,
      });
      return { text: '', model: '', latencyMs: 0 };
    }
  }
}
