/**
 * The mechanical half of an LLM call, in one deep module (ADR-0037).
 *
 * Every model call in the system re-implements the same steps — resolve the provider, build the
 * @ai-sdk/openai client, run generateText, read usage, handle an empty/failed result. `generate`
 * owns that MECHANISM and nothing else: it resolves the provider LAZILY on every call (never caches
 * it — the load-order foot-gun documented in provider.ts), runs the call, optionally retries once on
 * empty visible text, and sums usage + latency across the attempts. It does NOT decide what a failure
 * or an empty result MEANS — that is fail policy, which each caller keeps beside the code that
 * depends on it. Transport errors throw; empty output is a returned value, not an error.
 *
 * Exposed only via the `@wabi/shared/generate` subpath (never the barrel) so the `ai`/`@ai-sdk/openai`
 * libraries never enter @wabi/web's bundle graph (it imports the barrel and runs no inference).
 */
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, generateObject as aiGenerateObject } from 'ai';
import type { Tracer } from '@opentelemetry/api';
import type { ZodSchema } from 'zod';
import { getProvider, type ProviderRole } from './provider';

/**
 * Opt-in OpenTelemetry instrumentation for a single `generate` call (ADR-0037 caller-owns-policy
 * seam, ADR-0038). When `isEnabled`, the AI SDK emits a generation span (model, token usage, latency)
 * to the supplied `tracer`. Off/undefined means NO telemetry — the invariant for every call ABOVE the
 * crisis gate, where auto-instrumentation would capture raw pre-verdict content. Only the below-gate
 * `coach` call enables it.
 */
export interface GenerateTelemetry {
  isEnabled?: boolean;
  functionId?: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  metadata?: Record<string, string | number | boolean>;
  /** OTEL tracer to route AI-SDK spans to — the isolated Langfuse provider's tracer, never the global one. */
  tracer?: Tracer;
}

/** Token usage, normalised so a field is present ONLY when the provider reported it — a real 0 is
 * kept; a count no attempt returned stays absent (never coerced to zero). */
export interface GenerateUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** The operational diagnostic emitted (via the opt-in `log` hook) when output is empty after any
 * retry — the single home for the "the token cap may be too small" warning. */
export interface GenerateEmptyDiagnostic {
  kind: 'empty-output';
  model: string;
  baseUrl: string;
  cap: number;
}

export interface GenerateOptions {
  /** The user/content prompt (required). */
  prompt: string;
  /** Optional system message — research call sites omit it. */
  system?: string;
  /** Sampling temperature for the first attempt. */
  temperature?: number;
  /** The output-token budget — the cap that bites a reasoning model into returning empty text. */
  maxOutputTokens: number;
  /** Opt-in: when set and the first attempt returns empty visible text, retry ONCE at this lower
   * temperature. Off by default — the high-volume/fail-closed paths skip it. */
  retryOnEmpty?: { temperature: number };
  /** Optional hook so the module can surface the empty/cap diagnostic without depending on a concrete
   * logger. Fires only when output is still empty after any retry. */
  log?: (event: GenerateEmptyDiagnostic) => void;
  /** Opt-in OpenTelemetry instrumentation for this call. Off by default — the call site decides
   * (the crisis-gate boundary depends on classifier/router calls NOT being instrumented). */
  telemetry?: GenerateTelemetry;
}

export interface GenerateResult {
  /** The reply text, pre-trimmed. Empty string when the model produced nothing (after any retry). */
  text: string;
  /** Normalised, summed-across-attempts usage; undefined when no attempt reported any count. */
  usage?: GenerateUsage;
  /** The resolved model id for this call. */
  model: string;
  /** Wall-clock latency in ms, summed across attempts when a retry occurred. */
  latencyMs: number;
}

/**
 * A single completed LLM call's telemetry — the resolved model id and its token usage. Reported
 * OUT-OF-BAND (via an optional sink) by the safety/router seams whose primary return is a verdict, so
 * a tracer can stamp model/usage on the manual generation span WITHOUT those seams depending on the
 * tracing module. Model id and token counts are operational metadata, not personal data.
 */
export interface GenerationCallTelemetry {
  model: string;
  usage?: GenerateUsage;
}

type RawUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

/** Sum the per-attempt counts, then drop any field no attempt reported (so absent != 0). */
function sumUsage(parts: RawUsage[]): GenerateUsage | undefined {
  const fields: (keyof GenerateUsage)[] = ['inputTokens', 'outputTokens', 'totalTokens'];
  const out: GenerateUsage = {};
  for (const field of fields) {
    let sum: number | undefined;
    for (const part of parts) {
      if (part && typeof part[field] === 'number') sum = (sum ?? 0) + (part[field] as number);
    }
    if (sum !== undefined) out[field] = sum;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function generate(role: ProviderRole, opts: GenerateOptions): Promise<GenerateResult> {
  // LAZY, per-call: re-read the provider every time. The bot starts without inference env vars in
  // process.env (ConfigModule populates them after @wabi/shared is imported); caching this in a field
  // or const froze the classifier to OpenAI defaults -> 401 -> a crisis alert on every message.
  const cfg = getProvider(role);
  const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  const model = openai(cfg.model);

  const start = Date.now();
  const usageParts: RawUsage[] = [];

  const first = await generateText({
    model,
    system: opts.system,
    prompt: opts.prompt,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    experimental_telemetry: opts.telemetry,
  });
  let text = first.text.trim();
  usageParts.push(first.usage as RawUsage);

  // Opt-in second chance: a blank reply gets one retry at the lower temperature. Its usage and the
  // extra latency are both counted — the first attempt can burn tokens then return whitespace, and
  // dropping that under-counts the call's real (billed) cost.
  if (!text && opts.retryOnEmpty) {
    const retry = await generateText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      temperature: opts.retryOnEmpty.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      // No telemetry on the retry: the AI SDK emits one generation span per call, so re-passing it would
      // produce TWO generation spans (double token/cost + duplicate prompt/reply capture) under one coach
      // parent for a single logical turn. The first attempt's span already represents the call.
    });
    text = retry.text.trim();
    usageParts.push(retry.usage as RawUsage);
  }

  const latencyMs = Date.now() - start;

  if (!text && opts.log) {
    opts.log({ kind: 'empty-output', model: cfg.model, baseUrl: cfg.baseUrl, cap: opts.maxOutputTokens });
  }

  return { text, usage: sumUsage(usageParts), model: cfg.model, latencyMs };
}

/**
 * Structured-output sibling of `generate` (ADR-0037). Resolves the provider lazily, runs the AI
 * SDK's `generateObject`, and returns the typed object + normalised usage. Schema-validation /
 * no-object failures return `{ object: undefined, ... }` — the caller owns fail policy (never
 * throws on a parse error). Transport errors propagate unchanged so each call site maps them to its
 * own domain fail-open value. No retry, no telemetry wiring — these belong to callers that need them.
 */
export interface GenerateObjectOptions<T> extends Omit<GenerateOptions, never> { schema: ZodSchema<T>; }
export interface GenerateObjectResult<T> { object?: T; usage?: GenerateUsage; model: string; latencyMs: number; }

export async function generateObject<T>(role: ProviderRole, opts: GenerateObjectOptions<T>): Promise<GenerateObjectResult<T>> {
  const cfg = getProvider(role);
  const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  const start = Date.now();
  try {
    const res = await aiGenerateObject({
      model: openai(cfg.model),
      schema: opts.schema,
      system: opts.system,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
    });
    return { object: res.object as T, usage: sumUsage([res.usage as RawUsage]), model: cfg.model, latencyMs: Date.now() - start };
  } catch (err) {
    // Schema-validation / no-object failure is a returned value, not a throw — caller owns fail policy.
    if ((err as { name?: string })?.name === 'AI_NoObjectGeneratedError') {
      const u = (err as { usage?: RawUsage }).usage;
      return { object: undefined, usage: sumUsage([u]), model: cfg.model, latencyMs: Date.now() - start };
    }
    throw err; // transport errors still propagate
  }
}
