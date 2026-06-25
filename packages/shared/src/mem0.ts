// The single Mem0 REST client for wabi. Plain TS (no NestJS) so every package can share it: the bot's
// MemoryStoreService wraps it as an @Injectable for logging/DI, the voice surface imports `recall`
// directly. All access is namespaced by the `mem0_<userId>` key (ADR-0025 hybrid graph), so the DM and
// voice surfaces read/write the same derived facts for the same person.
//
// Lazy-config rule: MEM0_URL is read from process.env on every call, never cached at import — the bot
// process starts before ConfigModule populates env. HTTP errors are surfaced via an optional onError
// callback (so callers can log them); network errors propagate, except `recall` which fails fully open.

export type ErrorHandler = (status: number, body: string) => void;

/** A derived-memory fact with no query context (full export / delete enumeration). */
export type MemoryEntry = { id: string; content: string };

/**
 * A derived-memory fact from {@link search}. Always carries a numeric `similarity` (0 when mem0 omits a
 * score), so a hit satisfies the coach's recency ranker with no massaging. `updatedAt` (epoch ms, from
 * updated_at falling back to created_at) is optional — not every graph-derived hit is timestamped.
 */
export type MemorySearchHit = {
  id: string;
  content: string;
  similarity: number;
  updatedAt?: number;
};

/** Parsed create response: ids of the facts mem0 wrote, plus its event log (for observability). */
export type DeriveResult = {
  createdIds: string[];
  events: Array<{ id?: string; event?: string }>;
};

/**
 * How many hits to pull on search — wider than the prompt's display budget so the recency re-ranker can
 * promote an older-but-relevant fact instead of it being cut by mem0's raw similarity sort first.
 */
export const SEARCH_CANDIDATE_LIMIT = 20;

/**
 * Most-recent facts {@link recall} injects at call start. The coach bounds recall by similarity to the
 * live conversation; the voice surface has no utterance at call start, so it bounds by recency. Set high
 * enough that a normal user's whole derived-memory corpus is injected — a low cap silently drops older
 * facts (e.g. "has a cat named Apollo"), so the assistant can't answer specific questions about them.
 * ponytail: recency cap, fine while a user's corpus is small (tens of facts). If corpora grow into the
 * hundreds, switch to per-turn semantic search (mem0 /search with the utterance) like the coach does.
 */
export const RECALL_LIMIT = 20;

interface Mem0CreateResponse {
  id?: string;
  events?: Array<{ id?: string; event?: string }>;
  memories?: Array<{ id?: string }>;
}

interface Mem0SearchResponse {
  results?: Array<{
    id?: string;
    memory?: string;
    score?: number;
    updated_at?: string;
    created_at?: string;
  }>;
}

/** The mem0 namespace key for a wabi user — the convention every surface reads/writes under. */
export function mem0Key(userId: string): string {
  return `mem0_${userId}`;
}

/**
 * The one request mechanism. Fetch a URL, parse JSON on success. On a non-OK response calls `onError`
 * with the status and the body truncated to 200 chars and returns null. Network errors propagate
 * (callers decide whether to swallow — `recall` does, the rest surface null).
 */
async function mem0Request<T>(
  url: string,
  options?: RequestInit,
  onError?: ErrorHandler,
): Promise<T | null> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    onError?.(res.status, body.slice(0, 200));
    return null;
  }
  return res.json() as Promise<T>;
}

/**
 * The single recency rule for a mem0 fact, shared by `search` (per-hit `updatedAt`) and `recall`
 * (newest-first sort). Converts ISO timestamps to epoch ms, preferring a *parseable* updated_at over
 * created_at; returns undefined only when neither parses. A present-but-unparseable updated_at falls
 * through to created_at — so a fact with a malformed updated_at but a valid created_at sorts by its
 * real recency instead of dropping to epoch 0 and being cut from `recall`'s newest-first slice.
 * `recall` supplies the sort `0`-fallback at its call site via `?? 0`.
 */
export function recencyMs(updatedAt?: string, createdAt?: string): number | undefined {
  for (const iso of [updatedAt, createdAt]) {
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * The one GET-by-user core: raw passthrough of mem0's `results[]` for `mem0_<userId>`, or null on a
 * non-OK response. Both `recall` (recency-bounded, fail-open) and `getAllForUser` (full enumeration,
 * null on error) read this one endpoint and apply their own view + fail policy. Exported for unit
 * tests; deliberately NOT re-exported from the barrel (`index.ts`) — not part of the public interface.
 */
export async function listMemories(
  userId: string,
  onError?: ErrorHandler,
): Promise<NonNullable<Mem0SearchResponse['results']> | null> {
  const json = await mem0Request<Mem0SearchResponse>(
    `${process.env.MEM0_URL}/memories?user_id=${encodeURIComponent(mem0Key(userId))}`,
    undefined,
    onError,
  );
  if (!json) return null;
  return json.results ?? [];
}

// mem0's create response shape varies: the id may be top-level, in events[].id, or memories[].id.
function extractCreatedIds(json: Mem0CreateResponse): string[] {
  const ids: string[] = [];
  if (json.id) ids.push(json.id);
  for (const evt of json.events ?? []) if (evt.id) ids.push(evt.id);
  for (const m of json.memories ?? []) if (m.id && !ids.includes(m.id)) ids.push(m.id);
  return ids;
}

/**
 * Derive and store memory from a session's text. Returns the parsed create result, or null on a non-OK
 * response (already reported via onError). Caller must have MEM0_URL set. Network errors propagate.
 */
export async function deriveAndStore(
  userId: string,
  sessionText: string,
  onError?: ErrorHandler,
): Promise<DeriveResult | null> {
  const json = await mem0Request<Mem0CreateResponse>(
    `${process.env.MEM0_URL}/memories`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: sessionText }],
        user_id: mem0Key(userId),
      }),
    },
    onError,
  );
  if (!json) return null;
  return { createdIds: extractCreatedIds(json), events: json.events ?? [] };
}

/**
 * Semantic search of a user's facts (the coach's recall): POST /search, scored, capped at
 * {@link SEARCH_CANDIDATE_LIMIT}. Returns hits, or null on a non-OK response. Network errors propagate.
 */
export async function search(
  userId: string,
  query: string,
  onError?: ErrorHandler,
): Promise<MemorySearchHit[] | null> {
  const json = await mem0Request<Mem0SearchResponse>(
    `${process.env.MEM0_URL}/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        user_id: mem0Key(userId),
        limit: SEARCH_CANDIDATE_LIMIT,
      }),
    },
    onError,
  );
  if (!json) return null;
  return (json.results ?? []).map((r) => ({
    id: r.id ?? '',
    content: r.memory ?? '',
    similarity: r.score ?? 0,
    updatedAt: recencyMs(r.updated_at, r.created_at),
  }));
}

/** Every fact for a user, unscored (full export / delete enumeration). Null on a non-OK response. */
export async function getAllForUser(
  userId: string,
  onError?: ErrorHandler,
): Promise<MemoryEntry[] | null> {
  const results = await listMemories(userId, onError);
  if (!results) return null;
  return results.map((r) => ({ id: r.id ?? '', content: r.memory ?? '' }));
}

/**
 * Delete every fact for a user. Privacy-critical: mem0's delete_all cascades to BOTH the Qdrant vectors
 * and the neo4j subgraph, so this must stay namespaced by mem0_<userId> (ADR-0025).
 */
export async function deleteAllForUser(
  userId: string,
  onError?: ErrorHandler,
): Promise<boolean> {
  const res = await mem0Request(
    `${process.env.MEM0_URL}/memories?user_id=${encodeURIComponent(mem0Key(userId))}`,
    { method: 'DELETE' },
    onError,
  );
  return res !== null;
}

/**
 * Recall a user's facts for system-prompt injection: newest-first, capped at {@link RECALL_LIMIT}. Reads
 * MEM0_URL lazily and fails fully open to [] (missing URL, non-OK, or any thrown error) so a degraded
 * mem0 yields a plain assistant rather than a broken call.
 */
export async function recall(userId: string): Promise<string[]> {
  // Explicit guard kept for clarity (and to avoid a doomed fetch on an undefined URL).
  if (!process.env.MEM0_URL) return [];
  // Fail fully open: listMemories returns null on non-OK; a propagated network error is caught here.
  const results = await listMemories(userId).catch(() => null);
  return (results ?? [])
    .filter((r) => !!r.memory)
    .sort(
      (a, b) =>
        (recencyMs(b.updated_at, b.created_at) ?? 0) -
        (recencyMs(a.updated_at, a.created_at) ?? 0),
    ) // newest first
    .slice(0, RECALL_LIMIT)
    .map((r) => r.memory as string);
}
