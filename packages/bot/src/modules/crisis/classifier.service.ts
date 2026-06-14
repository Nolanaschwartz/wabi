import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider, type ProviderConfig } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

export type ClassifierResult = 'safe' | 'crisis';

/**
 * Optional, disambiguating context for a single classification. The classifier is otherwise
 * context-blind — it sees one coalesced message and nothing else — and its deliberately fail-closed
 * bias tips bare ambiguous phrases ("it's not helping") to 'crisis'. Supplying the situation the
 * message arrived in lets the model read it correctly WITHOUT lowering crisis sensitivity. The
 * zero-dependency tripwire still runs on the raw message upstream regardless of this. (ADR-0021.)
 */
export interface ClassifierContext {
  /** The user is in an active tilt-reset session, working a coping technique the bot suggested. */
  inTiltSession?: boolean;
  /** Recent DM turns (oldest→newest) so a short reply lands against what was actually said. */
  recentTurns?: Array<{ role: string; content: string }>;
}

// Reasoning models (e.g. qwopus-3.6) burn output tokens on hidden reasoning before printing the
// verdict. A 10-token cap left content empty for every message. 256 was the reliable floor against
// qwopus-3.6; 512 gives margin without meaningfully slowing the turn.
const CLASSIFIER_MAX_OUTPUT_TOKENS = 512;

// Sharpened from the original. The crisis criteria are unchanged in strength (genuine self-harm /
// suicide intent / severe distress about being alive), and the fail-closed clause is retained but
// scoped to the dimension that matters (self-harm ambiguity) so it no longer sweeps in plainly benign
// frustration. The explicit safe carve-out for "a coping technique isn't working" is what stops the
// tilt-session false positive at the prompt layer. (ADR-0021.)
const CLASSIFIER_SYSTEM_PROMPT =
  'Respond with ONLY "crisis" or "safe". These are Discord DMs to a wellness companion for gamers, ' +
  'who often use hyperbole about matches ("this game is killing me", "I\'m so dead", "I want to throw ' +
  'my PC") — treat game-directed hyperbole as venting, not intent. Classify as "crisis" only if the ' +
  'message shows genuine self-harm ideation, suicide intent, or severe distress about being alive. ' +
  'Classify as "safe" for gaming slang, hyperbole, venting about a game or teammates, or frustration ' +
  'that advice or a coping technique is not working (for example "it\'s not helping"). When the message ' +
  'is genuinely ambiguous about self-harm or suicide intent, classify as "crisis".';

// Bound the carried history to the most recent user messages so a long session can't bloat the
// safety-path prompt. The window keeps the assistant turns interleaved among them — the bot's last
// line ("try 4-7-8 breathing") is often exactly what a short reply ("it's not helping") reacts to,
// so clamping by user-message count rather than dropping assistant turns preserves the disambiguator.
const MAX_CONTEXT_USER_MESSAGES = 5;

@Injectable()
export class ClassifierService {
  private readonly logger = new JsonLogger(ClassifierService.name);
  private config: ProviderConfig;

  constructor() {
    this.config = getProvider('classifier');
  }

  async classify(message: string, context?: ClassifierContext): Promise<ClassifierResult> {
    try {
      const openai = createOpenAI({
        baseURL: this.config.baseUrl as string,
        apiKey: this.config.apiKey,
      });

      const { text } = await generateText({
        model: openai(this.config.model),
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: this.buildPrompt(message, context),
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

  /**
   * Wrap every message in a uniform envelope so the classifier sees a consistent shape on EVERY call —
   * cold messages included. Any disambiguating context (active tilt session, recent turns) is prepended
   * as an additive block; with none, only the "Message to classify:" wrapper is emitted. The uniform
   * framing is deliberate: the safety classifier should not behave differently just because a message
   * happens to be the first of a session.
   */
  private buildPrompt(message: string, context?: ClassifierContext): string {
    const contextLines: string[] = [];
    if (context?.inTiltSession) {
      contextLines.push(
        'The user is in an active tilt-reset session, practicing a coping technique the bot ' +
          'suggested. Short frustration like "it\'s not helping" usually refers to that technique, ' +
          'not their life.',
      );
    }
    if (context?.recentTurns && context.recentTurns.length > 0) {
      contextLines.push('Recent messages:');
      for (const turn of this.clampToRecentUserMessages(context.recentTurns)) {
        contextLines.push(`  ${turn.role}: ${turn.content}`);
      }
    }

    const parts: string[] = [];
    if (contextLines.length > 0) {
      parts.push('Conversation context (background only):', ...contextLines, '');
    }
    parts.push('Message to classify:', message);
    return parts.join('\n');
  }

  /**
   * Take the tail of the conversation covering at most MAX_CONTEXT_USER_MESSAGES user messages, with
   * the assistant turns between them preserved. Walks back from the most recent turn and stops before
   * a (MAX+1)th user message — so older history is dropped but the recent exchange stays intact.
   */
  private clampToRecentUserMessages(
    turns: Array<{ role: string; content: string }>,
  ): Array<{ role: string; content: string }> {
    let userCount = 0;
    let start = turns.length;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') {
        if (userCount >= MAX_CONTEXT_USER_MESSAGES) break;
        userCount++;
      }
      start = i;
    }
    return turns.slice(start);
  }
}
