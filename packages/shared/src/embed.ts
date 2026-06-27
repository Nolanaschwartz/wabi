/**
 * The mechanical half of an embedding call, in one deep module — the embeddings sibling of `generate`
 * (ADR-0037). Resolves the `embedding` provider LAZILY per call (never cache env-derived config —
 * CLAUDE.md), POSTs the OpenAI-compatible /v1/embeddings path, and returns the vector. Fail-open: any
 * transport/non-ok/parse failure returns [] (the documented degraded mode — callers fall back).
 *
 * Exposed only via the `@wabi/shared/embed` subpath (never the barrel) so web never pulls it in.
 */
import { getProvider } from './provider';

export async function embed(text: string): Promise<number[]> {
  const cfg = getProvider('embedding');
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    return data?.data?.[0]?.embedding ?? [];
  } catch {
    return [];
  }
}
