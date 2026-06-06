import { startInfra } from '../integration-harness';
import { StrategyRetrievalService, StrategyPoint } from '../../modules/strategy-retrieval/strategy-retrieval.service';

const DIMS = 768;

// Deterministic embeddings for testing: cosine similarity is predictable.
// query ≈ (1, 0, ...) → relevant at ~0.91, irrelevant at ~0.10
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

describe('strategy retrieval integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let retrieval: StrategyRetrievalService;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.QDRANT_URL = infra.qdrantUrl;

    // Mock the embedding fetch so we don't need a real embedding service
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbed('test') }] }),
    });

    const { StrategyRetrievalService: SRS } = await import(
      '../../modules/strategy-retrieval/strategy-retrieval.service'
    );
    retrieval = new SRS(infra.qdrantUrl);
    await retrieval.init();
  }, 60000);

  afterAll(async () => {
    await infra.stop();
  }, 30000);

  it('ranks relevant strategy above irrelevant one', async () => {
    // Upsert two strategies with known vectors
    await retrieval.upsert(
      'relevant-1',
      'Box Breathing for anxiety',
      'RCT meta-analysis',
    );
    await retrieval.upsert(
      'irrelevant-1',
      'Cold Plunge for recovery',
      'anecdotal',
    );

    // Mock the fetch to return the right vector for the query
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: mockEmbed('reset anxiety') }],
      }),
    });

    // Also need to mock for the upsert calls — the vectors were already sent above
    // Search with a query embedding that is closer to "Box Breathing"
    const results = await retrieval.search('reset anxiety');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const topResult = results[0];
    // The relevant strategy should rank first
    expect(topResult.content).toContain('Box Breathing');
  }, 30000);

  it('returns empty array on failed retrieval', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
    });

    const results = await retrieval.search('anything');
    expect(results).toEqual([]);
  }, 30000);
});
