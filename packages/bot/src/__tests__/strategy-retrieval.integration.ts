import { randomUUID } from 'crypto';
import { startInfra } from '../integration-harness';
import { StrategyRetrievalService } from '../modules/strategy-retrieval/strategy-retrieval.service';

const DIMS = 768;

// The real fetch, captured once before any mocking. Qdrant's REST client also uses
// global.fetch, so the embed mock must delegate non-embedding requests here rather
// than swallow them (an all-requests mock breaks every Qdrant call).
const realFetch = global.fetch;

// Deterministic embeddings for testing: cosine similarity is predictable.
// query ≈ (1, 0, ...) → relevant at ~0.99, irrelevant at ~0.16
function mockEmbed(text: string): number[] {
  if (text.includes('reset') && text.includes('anxiety')) {
    return makeVector(1, 0);
  }
  if (text.includes('Box Breathing')) {
    return makeVector(0.9, 0.1);
  }
  if (text.includes('Cold Plunge')) {
    return makeVector(0.1, 0.9);
  }
  return makeVector(0.5, 0.5);
}

function makeVector(a: number, b: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

// Mock only the embedding endpoint (no live LLM); pass Qdrant's own HTTP through to
// the real container. The returned vector is derived from the request's `input` text,
// so each strategy gets a distinct embedding and ranking is meaningful.
function installEmbedMock(): void {
  global.fetch = jest.fn().mockImplementation((url: string, opts: any) => {
    if (typeof url === 'string' && url.includes('/api/embeddings')) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbed(body.input) }] }),
      });
    }
    return realFetch(url as any, opts);
  }) as unknown as typeof fetch;
}

// Qdrant upserts without wait=true are applied asynchronously; retry the search a few
// times so the test does not race the indexer.
async function searchWithRetry(
  retrieval: StrategyRetrievalService,
  query: string,
  attempts = 10,
) {
  for (let i = 0; i < attempts; i++) {
    const results = await retrieval.search(query);
    if (results.length > 0) return results;
    await new Promise((r) => setTimeout(r, 200));
  }
  return retrieval.search(query);
}

describe('strategy retrieval integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let retrieval: StrategyRetrievalService;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.QDRANT_URL = infra.qdrantUrl;

    installEmbedMock();

    const { StrategyRetrievalService: SRS } = await import(
      '../modules/strategy-retrieval/strategy-retrieval.service'
    );
    retrieval = new SRS(infra.qdrantUrl);
    await retrieval.init();
  }, 60000);

  afterAll(async () => {
    global.fetch = realFetch;
    await infra.stop();
  }, 30000);

  it('ranks relevant strategy above irrelevant one', async () => {
    // Qdrant point IDs must be unsigned integers or UUIDs.
    await retrieval.upsert(randomUUID(), 'Box Breathing for anxiety', 'RCT meta-analysis');
    await retrieval.upsert(randomUUID(), 'Cold Plunge for recovery', 'anecdotal');

    const results = await searchWithRetry(retrieval, 'reset anxiety');

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The relevant strategy ranks first: query (1,0) is closest to Box Breathing (0.9,0.1).
    expect(results[0].content).toContain('Box Breathing');
  }, 30000);

  it('returns empty array on failed retrieval', async () => {
    // Force the embedding call to fail; search must degrade to [].
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 500 }),
    );

    const results = await retrieval.search('anything');
    expect(results).toEqual([]);

    // Restore the delegating mock for any subsequent work.
    installEmbedMock();
  }, 30000);
});
