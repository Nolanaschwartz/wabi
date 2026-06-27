import { generate, generateObject, type GenerateResult } from '@wabi/shared/generate';
import { extractMaxTokens, triageMaxTokens } from '../config';
import type { ResearchSpanInput, ResearchSpanName } from './research-tracer';
import type { ZodSchema } from 'zod';

/** The slice of the tracer the seam needs: emit one span. Kept as a structural interface (not the
 * concrete class) so a test hands `gen` a fake tracer. Mirrors {@link AgentTracer} in research-agent. */
export interface SpanEmitter {
  span(input: ResearchSpanInput): void;
}

/** The two research roles a pipeline step can call through (a subset of @wabi/shared's ProviderRole).
 * The `gen` seam binds each to its standard reasoning-model output cap, so no step can silently
 * under-cap and starve a reasoning model into an empty reply (the cap foot-gun documented in config.ts). */
export type ResearchRole = 'research' | 'research-triage';

/** The per-call knobs a step still owns: its prompt, and (gate only) a fixed temperature. Everything
 * mechanical — role→cap binding, the generate call, span emission — lives in {@link makeResearchGenerate}. */
export interface ResearchGenerateOptions {
  prompt: string;
  /** Optional system message — research steps omit it today, but the seam passes it through. */
  system?: string;
  /** Sampling temperature (the gate pins this to 0 for a deterministic binary verdict). */
  temperature?: number;
}

/**
 * The single research LLM seam. A step calls `gen(spanName, role, opts)`; the seam binds the role's
 * standard output cap, runs the shared `generate`, and ON SUCCESS emits that step's Langfuse generation
 * span (the tracing convergence — one place owns span shape/usage/latency).
 *
 * It does NOT own fail policy: a transport throw PROPAGATES so each step's own catch produces its
 * domain fail-open value (gate keeps, extract `[]`, judge neutral, dedup not-duplicate, merge un-merged).
 */
export type ResearchGenerate = (
  spanName: ResearchSpanName,
  role: ResearchRole,
  opts: ResearchGenerateOptions,
) => Promise<GenerateResult>;

/** The standard reasoning-model output cap for a role (config.ts owns the values, lazily per call). */
function capForRole(role: ResearchRole): number {
  return role === 'research' ? extractMaxTokens() : triageMaxTokens();
}

/**
 * Build the per-run `gen` seam from the run's tracer + run-id. When both are absent (tracing disabled),
 * `gen` still runs `generate` and simply emits no span. Tracing stays fail-open — the tracer's `span`
 * already swallows its own errors (ADR-0021), so a tracer fault never breaks a run; the generate throw
 * is the ONLY thing that propagates, and only to the calling step's catch.
 */
export function makeResearchGenerate(tracer?: SpanEmitter, runId?: string): ResearchGenerate {
  return async (spanName, role, opts) => {
    // Transport errors PROPAGATE (not caught here): the step's own catch maps them to its fail-open
    // domain value. Only a SUCCESSFUL call reaches the span emission below.
    const result = await generate(role, {
      prompt: opts.prompt,
      system: opts.system,
      temperature: opts.temperature,
      maxOutputTokens: capForRole(role),
    });

    if (tracer && runId) {
      // Tracing is fail-open (ADR-0021): emit the span, but a tracer fault must NEVER propagate into the
      // step's catch (which would corrupt its domain result to the fail-open value). Only the `generate`
      // throw above propagates — span emission is guarded here even though the real tracer also swallows.
      try {
        tracer.span({
          runId,
          span: spanName,
          input: opts.prompt,
          output: result.text,
          model: result.model,
          usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
          latencyMs: result.latencyMs,
        });
      } catch {
        // swallowed — a tracing error is never allowed to break a run
      }
    }

    return result;
  };
}

/**
 * The structured-output sibling of {@link ResearchGenerate}. A step calls
 * `genObj(spanName, role, { prompt, schema })`; the seam binds the role's standard output cap,
 * runs `generateObject`, and ON SUCCESS emits the same Langfuse generation span shape as `gen`.
 * Transport errors propagate; no-object (schema/validation failure) returns object undefined with
 * tokens 0 — the caller owns fail policy. Tracing stays fail-open per ADR-0021.
 */
export type ResearchGenerateObject = <T>(
  spanName: ResearchSpanName,
  role: ResearchRole,
  opts: { prompt: string; schema: ZodSchema<T>; system?: string; temperature?: number },
) => Promise<{ object?: T; tokens: number }>;

export function makeResearchGenerateObject(tracer?: SpanEmitter, runId?: string): ResearchGenerateObject {
  return async (spanName, role, opts) => {
    const result = await generateObject(role, { ...opts, maxOutputTokens: capForRole(role) });

    if (tracer && runId) {
      try {
        tracer.span({
          runId,
          span: spanName,
          input: opts.prompt,
          output: JSON.stringify(result.object ?? null),
          model: result.model,
          usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
          latencyMs: result.latencyMs,
        });
      } catch {
        // swallowed — a tracing error is never allowed to break a run
      }
    }

    return { object: result.object, tokens: result.usage?.totalTokens ?? 0 };
  };
}
