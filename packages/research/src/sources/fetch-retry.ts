/**
 * One GET that retries transient 5xx before giving up. Live biomedical APIs (NCBI E-utilities,
 * Europe PMC) 500/503 intermittently, and one blip otherwise zeroes a whole topic's source. 4xx
 * (and the final 5xx after retries) fail fast so genuine errors still surface. Two retries with a
 * linear 400ms·(n+1) backoff. Shared by pubmed + europepmc so their retry shape can't drift.
 *
 * The caller wraps this in its own RateLimiter.schedule and parses the returned Response.
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  label: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url);
    if (res.ok) return res;
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    throw new Error(`${label} HTTP ${res.status}`);
  }
}
