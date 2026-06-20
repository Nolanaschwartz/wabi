import { mem0Key, recall } from './mem0';

const okJson = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe('mem0Key', () => {
  it('uses the mem0_<userId> convention the DM path writes under', () => {
    expect(mem0Key('u1')).toBe('mem0_u1');
  });
});

describe('recall', () => {
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
