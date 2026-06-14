import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

/** Wellness-verb intents the router can dispatch to. `coach` is the catch-all / fallback. */
export type Intent = 'journal' | 'tilt' | 'mood' | 'coach';

const INTENTS: readonly Intent[] = ['journal', 'tilt', 'mood', 'coach'];

/**
 * Journal sub-intent (which journal tool the person wants), folded into the discovery verdict so the
 * hub never has to guess it from regex. `give_prompt` = they're ASKING for a prompt to write against;
 * `save_entry` = they're providing the entry text. Only meaningful when intent === 'journal'.
 */
export type JournalTool = 'give_prompt' | 'save_entry' | 'get_entry';

const JOURNAL_TOOLS: readonly JournalTool[] = ['give_prompt', 'save_entry', 'get_entry'];

export interface IntentResult {
  intent: Intent;
  /** Model confidence in [0, 1]. 0 means "no usable signal" (fail-soft default). */
  confidence: number;
  /** Journal sub-intent. Present only for a journal verdict that carried a valid tool. */
  tool?: JournalTool;
}

/**
 * Optional disambiguating context. Unused in Slice A2 (observe-only) but part of the seam so later
 * slices can feed recent turns without changing the signature.
 */
export interface IntentContext {
  recentTurns?: Array<{ role: string; content: string }>;
}

/** The fail-soft verdict: when in any doubt, fall through to coaching. Never a safety surface. */
const FAIL_SOFT: IntentResult = { intent: 'coach', confidence: 0 };

const ROUTER_MAX_OUTPUT_TOKENS = 256;

const ROUTER_SYSTEM_PROMPT =
  'You route a gamer\'s Discord DM to a wellness companion to the handler that best fits their intent. ' +
  'Respond with ONLY a JSON object: {"intent": <intent>, "confidence": <0..1>}. ' +
  'intent is one of: "journal" (they want to write/reflect on how they are doing), ' +
  '"tilt" (they want help calming gameplay frustration), "mood" (they want to log how they feel), ' +
  'or "coach" (anything else — general venting, chat, advice). ' +
  'confidence is your certainty in [0,1]. When unsure, use "coach" with low confidence. ' +
  'When intent is "journal", ALSO include "tool": "give_prompt" if they are ASKING you for a prompt or ' +
  'question to write against (e.g. "give me a journal prompt", "what should I journal about"), ' +
  '"get_entry" if they want to READ BACK a past entry (e.g. "what did I journal yesterday"), or ' +
  '"save_entry" if the message already IS the entry text they want recorded.';

/**
 * Stateless inference seam that classifies a DM's intent so the DM router can dispatch it. It is NOT a
 * safety surface — the crisis classifier owns that, upstream and in parallel. The router fails SOFT:
 * any error, empty output, unknown label, or out-of-range confidence resolves to coach/0 so a broken
 * router can only ever under-route to coaching, never mis-handle a turn. Provider is resolved lazily on
 * every call (CLAUDE.md: never cache env-derived config — ROUTER_* may load after import).
 */
@Injectable()
export class IntentRouterService {
  private readonly logger = new JsonLogger(IntentRouterService.name);

  async route(batch: string, context?: IntentContext): Promise<IntentResult> {
    try {
      const config = getProvider('router');
      const openai = createOpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });

      const { text } = await generateText({
        model: openai(config.model),
        system: ROUTER_SYSTEM_PROMPT,
        prompt: this.buildPrompt(batch, context),
        temperature: 0,
        maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      });

      return this.parse(text);
    } catch (err) {
      this.logger.warn(
        `Intent router call failed; failing soft to coach: ${err instanceof Error ? err.message : String(err)}`,
      );
      return FAIL_SOFT;
    }
  }

  /** Parse the model's JSON verdict, validating intent and confidence. Anything off → fail soft. */
  private parse(text: string | undefined): IntentResult {
    const match = (text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return FAIL_SOFT;

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return FAIL_SOFT;
    }

    const obj = parsed as { intent?: unknown; confidence?: unknown; tool?: unknown };
    const intent = obj.intent;
    const confidence = obj.confidence;

    if (typeof intent !== 'string' || !INTENTS.includes(intent as Intent)) return FAIL_SOFT;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return FAIL_SOFT;
    }

    const result: IntentResult = { intent: intent as Intent, confidence };
    // The tool sub-intent is journal-only; ignore it elsewhere or when the value is unrecognised.
    if (intent === 'journal' && typeof obj.tool === 'string' && JOURNAL_TOOLS.includes(obj.tool as JournalTool)) {
      result.tool = obj.tool as JournalTool;
    }
    return result;
  }

  private buildPrompt(batch: string, context?: IntentContext): string {
    const parts: string[] = [];
    if (context?.recentTurns && context.recentTurns.length > 0) {
      parts.push('Recent messages (background only):');
      for (const turn of context.recentTurns) parts.push(`  ${turn.role}: ${turn.content}`);
      parts.push('');
    }
    parts.push('Message to route:', batch);
    return parts.join('\n');
  }
}
