import { MemoryStoreService } from '../memory-store.service';

describe('MemoryStoreService', () => {
  let store: MemoryStoreService;

  beforeEach(() => {
    store = new MemoryStoreService();
  });

  it('is disabled when MEM0_URL is not set', () => {
    expect((store as any).enabled).toBe(false);
  });

  it('does not store when disabled', async () => {
    await store.deriveAndStore('123', 'test session');
    // Should not throw
  });

  it('returns empty array when disabled', async () => {
    const results = await store.search('123', 'test query');
    expect(results).toEqual([]);
  });

  it('does not delete when disabled', async () => {
    await store.deleteAllForUser('123');
    // Should not throw
  });
});

describe('MemoryStoreService when enabled (hybrid graph era, ADR-0025)', () => {
  const MEM0_URL = 'http://mem0:8081';
  let store: MemoryStoreService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.MEM0_URL = MEM0_URL;
    store = new MemoryStoreService();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    // The service logs to console.error on degraded paths; silence it so test output stays clean.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.MEM0_URL;
    jest.restoreAllMocks();
  });

  // Privacy-critical: this is the exact request that, via mem0's delete_all, cascades to BOTH the
  // Qdrant vectors and the neo4j subgraph (verified against mem0 0.1.117). The bot must keep issuing
  // it namespaced by mem0_<userId> so a user's graph is purged on delete-my-data.
  it('deletes a user via the namespaced mem0_<userId> endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });

    await store.deleteAllForUser('user-42');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${MEM0_URL}/memories?user_id=mem0_user-42`);
    expect(init).toMatchObject({ method: 'DELETE' });
  });

  // Graceful degradation (ADR-0021): when mem0 is unreachable — now including a neo4j outage, since
  // neo4j is a hard mem0 dependency — search must degrade to [] so the coach proceeds buffer-only.
  it('returns [] when mem0 is unreachable (graph/vector outage degrades to buffer-only)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await store.search('user-42', 'how am I doing');

    expect(results).toEqual([]);
  });

  it('returns [] when mem0 responds with a non-OK status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'neo4j down' });

    const results = await store.search('user-42', 'how am I doing');

    expect(results).toEqual([]);
  });

  it('maps mem0 search hits to {id, content}', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ id: 'm1', memory: 'tilts in ranked' }] }),
    });

    const results = await store.search('user-42', 'ranked');

    expect(results).toEqual([{ id: 'm1', content: 'tilts in ranked' }]);
  });
});
