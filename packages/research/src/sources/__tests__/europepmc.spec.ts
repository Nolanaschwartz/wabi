import { EuropePmcSource } from '../europepmc';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
function page(results: unknown[], nextCursorMark: string) {
  return jsonResponse({ nextCursorMark, resultList: { result: results } });
}
function rec(over: Record<string, unknown> = {}) {
  return { id: 'PPR1', source: 'PPR', doi: '10.1101/2026.01.01.1', title: 'Reappraisal for stress', abstractText: 'a method', ...over };
}

describe('EuropePmcSource', () => {
  it('issues a relevance-ranked SRC:PPR core query and parses results into preprint papers', async () => {
    const fetchFn = jest.fn().mockResolvedValue(page([rec()], 'NEXT'));
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0 });

    const papers = await src.search('(TITLE:reappraisal)', 5);

    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain('/europepmc/webservices/rest/search');
    expect(decodeURIComponent(url)).toContain('AND (SRC:PPR)');
    expect(url).toContain('format=json');
    expect(url).toContain('resultType=core');
    expect(url).toContain('cursorMark=');
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      sourceId: 'doi:10.1101/2026.01.01.1', sourceKind: 'europepmc', isPreprint: true,
      title: 'Reappraisal for stress', abstract: 'a method', url: 'https://doi.org/10.1101/2026.01.01.1',
    });
  });

  it('follows nextCursorMark across pages until the limit, deduping by id', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(page([rec({ doi: '10.1/a' })], 'CUR2'))
      .mockResolvedValueOnce(page([rec({ doi: '10.1/b' })], 'CUR2')); // cursor stops advancing → stop
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0, pageSize: 1 });

    const papers = await src.search('q', 10);

    expect(papers.map((p) => p.sourceId)).toEqual(['doi:10.1/a', 'doi:10.1/b']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1][0])).toContain('cursorMark=CUR2');
  });

  it('hydrate is identity', async () => {
    const src = new EuropePmcSource({ fetchFn: jest.fn(), minIntervalMs: 0 });
    const p = { sourceId: 'doi:x', sourceKind: 'europepmc' as const, title: 't', abstract: 'a', url: 'u', pubTypes: [], isPreprint: true };
    await expect(src.hydrate(p)).resolves.toBe(p);
  });

  it('fullText parses the result PDF when advertised, else returns null', async () => {
    const withPdf = rec({ doi: '10.1/pdf', fullTextUrlList: { fullTextUrl: [{ documentStyle: 'pdf', url: 'https://pdf.test/a.pdf' }] } });
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(page([withPdf], '*')) // terminal cursor → search stops after one page
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => '9' }, arrayBuffer: async () => new Uint8Array([1, 2]).buffer } as unknown as Response);
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0, parsePdf: async () => 'BODY TEXT' });

    const [paper] = await src.search('q', 5);
    expect(await src.fullText(paper)).toBe('BODY TEXT');
    expect(String(fetchFn.mock.calls[1][0])).toBe('https://pdf.test/a.pdf');
  });

  it('returns null full text when no PDF url is advertised', async () => {
    const fetchFn = jest.fn().mockResolvedValue(page([rec()], 'N')); // no fullTextUrlList
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0 });
    const [paper] = await src.search('q', 5);
    expect(await src.fullText(paper)).toBeNull();
  });

  it('retries a transient 5xx and recovers rather than zeroing the source', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce(page([rec({ doi: '10.1/ok' })], '*')); // terminal cursor → stop
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0 });
    const papers = await src.search('q', 5);
    expect(papers.map((p) => p.sourceId)).toEqual(['doi:10.1/ok']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails soft to the results gathered so far when 5xx persists past the retries', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const src = new EuropePmcSource({ fetchFn, minIntervalMs: 0 });
    await expect(src.search('q', 5)).resolves.toEqual([]);
  });
});
