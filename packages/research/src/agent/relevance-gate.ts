import { z } from 'zod';
import { SCOPE_FRAGMENT } from './scope-policy';
import type { ResearchGenerateObject } from './research-generate';

export interface GateResult { keep: boolean; tokens: number }

const GateSchema = z.object({ keep: z.boolean() });

/** Cheap relevance triage on a paper's abstract, before any full-text fetch (spec §Agent behavior).
 * Topic-aware: judges whether the abstract plausibly yields a self-administered practice for THIS run
 * topic (directly or via a transferable mechanism), against the shared non-clinical scope policy.
 * Fails OPEN: keep the paper unless the model clearly says "no". Absent/undefined object keeps it too
 * — a schema/validation failure returns object undefined and we must NOT read that as a rejection
 * (doing so silently dropped every paper against a reasoning model starved by the token cap). */
export async function relevanceGate(genObj: ResearchGenerateObject, abstract: string, topic: string): Promise<GateResult> {
  try {
    // The `genObj` seam owns the mechanism (role→cap binding, lazy provider resolution, the call, span
    // emission); the gate keeps its role, temperature, and fail-OPEN policy. No retry-on-empty — an
    // object-absent soft failure maps to keep below, same as a transport error, so a second attempt
    // buys nothing on this high-volume path.
    const prompt =
      `${SCOPE_FRAGMENT}\n\n` +
      `Topic: "${topic}". Could this abstract plausibly yield an in-scope practice relevant to that ` +
      `topic — directly, or via a transferable mechanism — either a technique it describes OR a ` +
      `finding that directly supports one? Answer "no" if it is out of scope or unrelated to the ` +
      `topic. Answer only "yes" or "no".\n\n` +
      `Abstract: ${abstract}`;
    const { object, tokens } = await genObj('gate', 'research-triage', {
      prompt,
      schema: GateSchema,
      temperature: 0, // deterministic binary gate — same abstract must yield the same verdict run-to-run
    });
    // Fail-open: when genObj returns object undefined (schema/soft failure), keep the paper rather than
    // silently losing coverage (ADR-0021). tokens are still counted even on a soft failure.
    if (object === undefined) return { keep: true, tokens };
    return { keep: object.keep, tokens };
  } catch {
    return { keep: true, tokens: 0 };
  }
}
