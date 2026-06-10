import { Injectable, Logger } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';

export type ClassifierResult = 'safe' | 'crisis';

// Reasoning models (e.g. qwopus-3.6) burn output tokens on hidden reasoning before printing the
// verdict. A 10-token cap left content empty for every message. 256 was the reliable floor against
// qwopus-3.6; 512 gives margin without meaningfully slowing the turn.
const CLASSIFIER_MAX_OUTPUT_TOKENS = 512;

@Injectable()
export class ClassifierService {
  private readonly logger = new Logger(ClassifierService.name);
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
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      });

      const verdict = (text ?? '').trim().toLowerCase();
      // Fail safe: only an explicit, unambiguous "safe" is treated as safe. Empty output (reasoning
      // model returned nothing) or anything unparseable falls through to crisis rather than silently
      // letting a real crisis past.
      if (verdict.includes('safe') && !verdict.includes('crisis')) {
        return 'safe';
      }
      if (!verdict.includes('crisis')) {
        this.logger.warn(
          `Classifier returned unparseable verdict ${JSON.stringify(text)}; failing safe to crisis`,
        );
      }
      return 'crisis';
    } catch (err) {
      // This silent fail-to-crisis was previously invisible: a misconfigured endpoint (e.g. the
      // provider-config load-order bug) made every call throw -> a crisis alert on every message,
      // with nothing logged. Always log so the failure mode is diagnosable.
      this.logger.error(
        `Classifier call failed (${this.config.baseUrl} / ${this.config.model}); failing safe to crisis`,
        err instanceof Error ? err.stack : String(err),
      );
      return 'crisis';
    }
  }
}
