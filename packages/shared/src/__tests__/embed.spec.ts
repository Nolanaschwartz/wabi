import { embed } from '../embed';

describe('embed', () => {
  const realFetch = global.fetch;
  afterEach(() => { (global as any).fetch = realFetch; process.env.EMBEDDING_API_KEY = ''; });

  it('posts to /v1/embeddings and returns the vector', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) });
    expect(await embed('hi')).toEqual([0.1, 0.2]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toMatch(/\/v1\/embeddings$/);
    expect((init.headers as any).Authorization).toBeUndefined(); // keyless → no Bearer
  });

  it('returns [] on a non-ok response (fail-open)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    expect(await embed('hi')).toEqual([]);
  });
});
