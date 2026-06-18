import { BotClient } from '../bot-client';

const candidate = {
  title: 't', technique: 'q', sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed' as const, trustLevel: 'research-agent' as const,
};

describe('BotClient', () => {
  it('seen sends the admin secret and returns the flag', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ seen: true }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.seen('PMID:1')).toBe(true);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toContain('/admin/strategies/seen?sourceId=PMID%3A1');
    expect(opts.headers['x-admin-secret']).toBe('sek');
  });

  it('submit maps 201 → submitted', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ status: 'submitted', draftId: 'd1' }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('submitted');
  });

  it('submit maps a 201 whose body says rejected → rejected (gate reject, no draft persisted)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ status: 'rejected' }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('rejected');
  });

  it('submit maps 409 → deduped', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ status: 'deduped' }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('deduped');
  });

  it('submit maps other failures → error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('error');
  });

  it('submitBatch posts all drafts for one paper and maps each result in order', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ results: [{ status: 'submitted', draftId: 'd1' }, { status: 'deduped' }] }),
    });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });

    const outcomes = await client.submitBatch([candidate, candidate]);

    expect(outcomes).toEqual(['submitted', 'deduped']);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('http://bot/admin/strategies/ingest/batch');
    expect(JSON.parse(opts.body)).toEqual({ candidates: [candidate, candidate] });
  });

  it('submitBatch maps a transport failure to error for every draft', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submitBatch([candidate, candidate])).toEqual(['error', 'error']);
  });

  it('submitBatch maps a thrown fetch to error for every draft', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('network'));
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submitBatch([candidate])).toEqual(['error']);
  });
});
