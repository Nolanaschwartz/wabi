import { SCOPE_FRAGMENT } from './scope-policy';
import type { ResearchGenerate } from './research-generate';

export interface GateResult { keep: boolean; tokens: number }

/** Cheap relevance triage on a paper's abstract, before any full-text fetch (spec §Agent behavior).
 * Topic-aware: judges whether the abstract plausibly yields a self-administered practice for THIS run
 * topic (directly or via a transferable mechanism), against the shared non-clinical scope policy.
 * Fails OPEN: keep the paper unless the model clearly says "no". Empty/uncertain output keeps it too
 * — a reasoning model whose answer is starved by the token cap returns "" and we must NOT read that
 * as a rejection (doing so silently dropped every paper against the local model). */
export async function relevanceGate(gen: ResearchGenerate, abstract: string, topic: string): Promise<GateResult> {
  try {
    // The `gen` seam owns the mechanism (role→cap binding, lazy provider resolution, the call, span
    // emission); the gate keeps its role, temperature, and fail-OPEN policy. No retry-on-empty — an
    // empty/starved reply maps to keep below, same as a transport error, so a second attempt buys
    // nothing on this high-volume path.
    const prompt =
      `${SCOPE_FRAGMENT}\n\n` +
      `Topic: "${topic}". Could this abstract plausibly yield an in-scope practice relevant to that ` +
      `topic — directly, or via a transferable mechanism — either a technique it describes OR a ` +
      `finding that directly supports one? Answer "no" if it is out of scope or unrelated to the ` +
      `topic. Answer only "yes" or "no".\n\n` +
      `Abstract: ${abstract}`;
    const { text, usage } = await gen('gate', 'research-triage', {
      prompt,
      temperature: 0, // deterministic binary gate — same abstract must yield the same verdict run-to-run
    });
    const t = (text ?? '').trim().toLowerCase();
    return {
      keep: !t.startsWith('no'),
      tokens: usage?.totalTokens ?? 0,
    };
  } catch {
    return { keep: true, tokens: 0 };
  }
}
