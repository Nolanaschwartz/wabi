import { Injectable } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

/** Wellness-verb intents the router can dispatch to. `coach` is the catch-all / fallback. */
export type Intent = 'journal' | 'tilt' | 'mood' | 'coach';

/** One spoke's tool as the router sees it — name plus a line of guidance for when to pick it. */
export interface CatalogueTool {
  name: string;
  description: string;
}

/** One spoke in the router's catalogue: its intent, what it is for, and the tools it exposes. */
export interface SpokeCatalogueEntry {
  intent: Intent;
  description: string;
  tools: CatalogueTool[];
}

/**
 * The hub's registry, projected to exactly what the router needs to build its prompt and validate a
 * verdict. The hub derives it from `Record<Intent, Spoke>` and passes it in, so a new spoke or tool is
 * declared in ONE place (the registry) and the router picks it up with no edit here (ADR-0032).
 */
export type SpokeCatalogue = SpokeCatalogueEntry[];

export interface IntentResult {
  intent: Intent;
  /** Model confidence in [0, 1]. 0 means "no usable signal" (fail-soft default). */
  confidence: number;
  /** The chosen spoke tool. Present only when the verdict carried a tool the catalogue recognises. */
  tool?: string;
}

/**
 * Optional disambiguating context for the intent router: recent turns let it distinguish a
 * technique-frustration reply from a fresh complaint.
 */
export interface IntentContext {
  recentTurns?: Array<{ role: string; content: string }>;
}

/** The fail-soft verdict: when in any doubt, fall through to coaching. Never a safety surface. */
const FAIL_SOFT: IntentResult = { intent: 'coach', confidence: 0 };

const ROUTER_MAX_OUTPUT_TOKENS = 256;

/**
 * Stateless inference seam that classifies a DM's intent so the DM router can dispatch it. It is NOT a
 * safety surface — the crisis classifier owns that, upstream and in parallel. The router fails SOFT:
 * any error, empty output, unknown label, or out-of-range confidence resolves to coach/0 so a broken
 * router can only ever under-route to coaching, never mis-handle a turn. Its system prompt and its
 * validation are BOTH generated from the spoke catalogue the hub passes in, so adding a tool needs no
 * edit here (ADR-0032). Provider is resolved lazily on every call (CLAUDE.md: never cache env-derived
 * config — ROUTER_* may load after import).
 */
@Injectable()
export class IntentRouterService {
  private readonly logger = new JsonLogger(IntentRouterService.name);

  async route(
    batch: string,
    catalogue: SpokeCatalogue,
    context?: IntentContext,
  ): Promise<IntentResult> {
    try {
      const config = getProvider('router');
      const openai = createOpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });

      const { text } = await generateText({
        model: openai(config.model),
        system: this.buildSystemPrompt(catalogue),
        prompt: this.buildPrompt(batch, context),
        temperature: 0,
        maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      });

      return this.parse(text, catalogue);
    } catch (err) {
      this.logger.warn(
        `Intent router call failed; failing soft to coach: ${err instanceof Error ? err.message : String(err)}`,
      );
      return FAIL_SOFT;
    }
  }

  /** Generate the system prompt from the catalogue — the single source of intents and their tools. */
  private buildSystemPrompt(catalogue: SpokeCatalogue): string {
    const intentLines = catalogue.map((e) => `- "${e.intent}": ${e.description}`).join('\n');
    const toolLines = catalogue
      .filter((e) => e.tools.length > 0)
      .map((e) => `- ${e.intent}: ${e.tools.map((t) => `"${t.name}" (${t.description})`).join('; ')}`)
      .join('\n');

    return [
      "You route a gamer's Discord DM to a wellness companion's handler that best fits their intent.",
      'Respond with ONLY a JSON object: {"intent": <intent>, "confidence": <0..1>, "tool": <tool>}.',
      'intent is one of:',
      intentLines,
      'confidence is your certainty in [0,1]. When unsure, use "coach" with low confidence.',
      'tool names the specific action within the chosen intent. Options by intent:',
      toolLines,
      'Include "tool" only when confident which action fits; otherwise omit it.',
    ].join('\n');
  }

  /** Parse the model's JSON verdict, validating intent/confidence/tool against the catalogue. */
  private parse(text: string | undefined, catalogue: SpokeCatalogue): IntentResult {
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

    const entry = typeof intent === 'string' ? catalogue.find((e) => e.intent === intent) : undefined;
    if (!entry) return FAIL_SOFT;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return FAIL_SOFT;
    }

    const result: IntentResult = { intent: entry.intent, confidence };
    // Accept the tool only when the catalogue lists it for this intent — an unknown or cross-intent
    // tool is dropped, and the spoke's own default tool takes over downstream.
    if (typeof obj.tool === 'string' && entry.tools.some((t) => t.name === obj.tool)) {
      result.tool = obj.tool;
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
