import { mem0Key, recall, RECALL_LIMIT, search, SEARCH_CANDIDATE_LIMIT } from '../mem0';

const okJson = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe('mem0Key', () => {
  it('uses the mem0_<userId> convention every surface reads/writes under', () => {
    expect(mem0Key('u1')).toBe('mem0_u1');
  });
});

describe('recall (voice surface: recency-bounded, fully fail-open)', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.MEM0_URL;

  beforeEach(() => {
    process.env.MEM0_URL = 'http://mem0.test';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (realUrl === undefined) delete process.env.MEM0_URL;
    else process.env.MEM0_URL = realUrl;
    jest.restoreAllMocks();
  });

  it('maps results[].memory to a string[]', async () => {
    global.fetch = jest.fn(async () =>
      okJson({ results: [{ memory: 'a' }, { memory: 'b' }] }),
    ) as jest.Mock;
    await expect(recall('u1')).resolves.toEqual(['a', 'b']);
  });

  it('drops entries with no memory text', async () => {
    global.fetch = jest.fn(async () =>
      okJson({ results: [{ memory: 'a' }, {}, { memory: '' }] }),
    ) as jest.Mock;
    await expect(recall('u1')).resolves.toEqual(['a']);
  });

  it('orders newest-first, preferring updated_at over created_at', async () => {
    global.fetch = jest.fn(async () =>
      okJson({
        results: [
          { memory: 'old', created_at: '2020-01-01T00:00:00Z' },
          { memory: 'new', created_at: '2024-01-01T00:00:00Z' },
          {
            memory: 'mid',
            created_at: '2020-01-01T00:00:00Z',
            updated_at: '2022-01-01T00:00:00Z',
          },
        ],
      }),
    ) as jest.Mock;
    await expect(recall('u1')).resolves.toEqual(['new', 'mid', 'old']);
  });

  it('caps at RECALL_LIMIT, keeping the most recent facts', async () => {
    const results = Array.from({ length: RECALL_LIMIT + 5 }, (_, i) => ({
      memory: `m${i}`,
      created_at: `2020-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    }));
    global.fetch = jest.fn(async () => okJson({ results })) as jest.Mock;
    const out = await recall('u1');
    expect(out).toHaveLength(RECALL_LIMIT);
    expect(out[0]).toBe(`m${RECALL_LIMIT + 4}`); // newest survives
    expect(out).not.toContain('m0'); // oldest dropped
  });

  it('queries the mem0_<userId> key', async () => {
    const fetchMock = jest.fn(async () => okJson({ results: [] })) as jest.Mock;
    global.fetch = fetchMock;
    await recall('u1');
    expect(fetchMock.mock.calls[0][0]).toContain('user_id=mem0_u1');
  });

  it('returns [] when MEM0_URL is unset (fail open to a plain assistant)', async () => {
    delete process.env.MEM0_URL;
    const fetchMock = jest.fn() as jest.Mock;
    global.fetch = fetchMock;
    await expect(recall('u1')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] on a non-OK HTTP response', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }) as Response) as jest.Mock;
    await expect(recall('u1')).resolves.toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as jest.Mock;
    await expect(recall('u1')).resolves.toEqual([]);
  });
});

describe('search (coach surface: semantic, scored)', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.MEM0_URL;

  beforeEach(() => {
    process.env.MEM0_URL = 'http://mem0.test';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (realUrl === undefined) delete process.env.MEM0_URL;
    else process.env.MEM0_URL = realUrl;
    jest.restoreAllMocks();
  });

  it('POSTs /search with the namespaced key and a wider-than-display candidate limit', async () => {
    const fetchMock = jest.fn(async () => okJson({ results: [] })) as jest.Mock;
    global.fetch = fetchMock;
    await search('u1', 'how am I doing');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://mem0.test/search');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ user_id: 'mem0_u1', limit: SEARCH_CANDIDATE_LIMIT });
    expect(SEARCH_CANDIDATE_LIMIT).toBeGreaterThan(5);
  });

  it('surfaces similarity (0 when omitted) and updatedAt epoch ms per hit', async () => {
    const iso = '2026-06-01T00:00:00.000Z';
    global.fetch = jest.fn(async () =>
      okJson({ results: [{ id: 'm1', memory: 'tilts in ranked', score: 0.42, updated_at: iso }] }),
    ) as jest.Mock;
    await expect(search('u1', 'ranked')).resolves.toEqual([
      { id: 'm1', content: 'tilts in ranked', similarity: 0.42, updatedAt: Date.parse(iso) },
    ]);
  });

  it('returns null on a non-OK response so callers can distinguish error from empty', async () => {
    global.fetch = jest.fn(async () =>
      ({ ok: false, status: 503, text: async () => 'neo4j down' }) as Response,
    ) as jest.Mock;
    await expect(search('u1', 'ranked')).resolves.toBeNull();
  });
});
