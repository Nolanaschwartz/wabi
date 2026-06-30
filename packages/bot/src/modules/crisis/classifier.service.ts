import { Injectable } from '@nestjs/common';
import { generate, type GenerationCallTelemetry } from '@wabi/shared/generate';
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
// Env-overridable: a reasoning model on a hosted provider may need a much larger cap so hidden
// reasoning tokens don't crowd out the verdict (empty verdict -> fail-to-crisis on every message).
const CLASSIFIER_MAX_OUTPUT_TOKENS = Number(process.env.CLASSIFIER_MAX_OUTPUT_TOKENS) || 512;

// Sharpened from the original. The crisis criteria are unchanged in strength (genuine self-harm /
// suicide intent / severe distress about being alive), and the fail-closed clause is retained but
// scoped to the dimension that matters (self-harm ambiguity) so it no longer sweeps in plainly benign
// frustration. The explicit safe carve-out for "a coping technique isn't working" is what stops the
// tilt-session false positive at the prompt layer. (ADR-0021.)
// `/no_think` (Qwen-family directive) suppresses hidden chain-of-thought: this is a one-word label
// task, not a reasoning task. Thinking added ~10s of latency per call AND caused false-positive crisis
// verdicts — the model talked itself into "crisis" on benign input ("4", "Doing well"), and when the
// reasoning overran CLASSIFIER_MAX_OUTPUT_TOKENS it returned empty and failed closed to crisis. Ponytail:
// prompt-level toggle; if the provider ignores it, thread providerOptions through generate() instead.
const CLASSIFIER_SYSTEM_PROMPT =
  '/no_think\n' +
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

  /**
   * Classify one message as 'safe' or 'crisis'. The verdict is the contract — fail-CLOSED (ADR-0021).
   * `onTelemetry`, when supplied, is invoked once with the call's model + token usage on a SUCCESSFUL
   * generate (never on a transport error — there is no model to report); it lets a tracer attribute the
   * manual `classify` span without this safety seam depending on the tracing module. It never affects
   * the verdict.
   */
  async classify(
    message: string,
    context?: ClassifierContext,
    onTelemetry?: (telemetry: GenerationCallTelemetry) => void,
  ): Promise<ClassifierResult> {
    try {
      // generate owns the MECHANISM (lazy provider resolution, the ai client, the call) — ADR-0037 —
      // so the load-order foot-gun that froze this to OpenAI defaults can't recur. The classifier keeps
      // only its role, prompt, cap, and fail policy. It THROWS only on a transport error; an empty
      // reasoning-model result comes back as empty `text` and is handled by the fail-closed branch
      // below, NOT here. retryOnEmpty is deliberately OFF: the safety path fails closed instantly with
      // no added latency.
      const { text, model, usage } = await generate('classifier', {
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: this.buildPrompt(message, context),
        temperature: 0,
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      });
      // Report telemetry for the completed call (model/usage are operational, not personal data). Guarded
      // so a sink error can never alter the fail-closed verdict.
      try {
        onTelemetry?.({ model, usage });
      } catch {
        /* never let observability affect the safety verdict */
      }

      const verdict = (text ?? '').trim().toLowerCase();
      // Fail closed: only an explicit, unambiguous "safe" is treated as safe. Empty output (a reasoning
      // model returned nothing) or anything unparseable falls through to crisis rather than silently
      // letting a real crisis past. This branch is what preserves fail-closed for empty `text` WITHOUT
      // depending on the transport-error path (ADR-0021).
      if (verdict.includes('safe') && !verdict.includes('crisis')) {
        return 'safe';
      }
      if (!verdict.includes('crisis')) {
        this.logger.warn(
          `Classifier returned empty/unparseable verdict ${JSON.stringify(text)}; failing closed to crisis`,
        );
      }
      return 'crisis';
    } catch (err) {
      // generate throws on transport error (a misconfigured endpoint, the network). That used to be an
      // invisible fail-to-crisis — a crisis alert on every message, nothing logged. Always log so the
      // failure mode stays diagnosable, then fail closed to crisis.
      this.logger.error(
        `Classifier call failed; failing closed to crisis`,
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
