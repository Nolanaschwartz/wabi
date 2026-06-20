// Read-only Mem0 recall for the voice surface. Mirrors the bot's MemoryStoreService.search read
// shape and the `mem0_<userId>` key, so voice and DM read the same derived facts for the same person.
// Deliberately NOT lifted into @wabi/shared — duplicating ~20 lines of REST is cheaper than coupling
// call -> bot for a single consumer. Lift only if a third consumer appears.

interface Mem0SearchResponse {
  results?: Array<{ memory?: string }>;
}

/** The Mem0 key for a wabi user — same convention the DM path writes under. */
export function mem0Key(userId: string): string {
  return `mem0_${userId}`;
}

/**
 * Recall a user's derived-memory facts. Reads MEM0_URL lazily (never cached at import — the lazy-config
 * rule). Fails open to [] on missing MEM0_URL, non-OK HTTP, or any thrown error, so a degraded Mem0
 * yields a plain assistant rather than a broken call.
 */
export async function recall(userId: string): Promise<string[]> {
  const baseUrl = process.env.MEM0_URL;
  if (!baseUrl) return [];
  try {
    const res = await fetch(
      `${baseUrl}/memories?user_id=${encodeURIComponent(mem0Key(userId))}`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as Mem0SearchResponse;
    return (json.results ?? [])
      .map((r) => r.memory)
      .filter((m): m is string => !!m);
  } catch {
    return [];
  }
}
