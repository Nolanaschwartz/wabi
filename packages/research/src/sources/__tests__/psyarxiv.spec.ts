import { createPsyArxivSource, PsyArxivSource } from '../psyarxiv';
import { Paper } from '../../types';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response);
}
function psy(sourceId: string): Paper {
  return { sourceId, sourceKind: 'psyarxiv', title: '', abstract: '', url: '', pubTypes: [], isPreprint: true };
}
// Minimal slice of the real OSF API v2 preprints response shape (verified live):
function rec(id: string, title: string, description: string) {
  return { id, type: 'preprints', attributes: { title, description, date_published: '2026-06-01T00:00:00' } };
}

describe('PsyArxivSource (topical)', () => {
  it('issues one filter[description][icontains] request per newline-joined phrase, over psyarxiv', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse({ data: [rec('aaa', 'A', 'reappraisal works')] }))
      .mockReturnValueOnce(jsonResponse({ data: [rec('bbb', 'B', 'rumination study')] }));
    const src = createPsyArxivSource({ fetchFn, minIntervalMs: 0 });

    const papers = await src.search('reappraisal\nrumination', 10);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url0 = decodeURIComponent(String(fetchFn.mock.calls[0][0]));
    expect(url0).toContain('filter[provider]=psyarxiv');
    expect(url0).toContain('filter[description][icontains]=reappraisal');
    expect(papers.map((p) => p.sourceId)).toEqual(['osf:aaa', 'osf:bbb']);
    expect(papers[0]).toMatchObject({ sourceKind: 'psyarxiv', isPreprint: true, title: 'A', abstract: 'reappraisal works', url: 'https://osf.io/aaa' });
  });

  it('dedupes a paper that matches more than one phrase, and caps at the limit', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse({ data: [rec('dup', 'D', 'x'), rec('two', 'T', 'y')] }))
      .mockReturnValueOnce(jsonResponse({ data: [rec('dup', 'D', 'x'), rec('three', 'X', 'z')] }));
    const src = createPsyArxivSource({ fetchFn, minIntervalMs: 0 });

    const papers = await src.search('p1\np2', 2);

    expect(papers.map((p) => p.sourceId)).toEqual(['osf:dup', 'osf:two']); // deduped + capped at 2
  });

  it('returns [] for an empty query and never fetches', async () => {
    const fetchFn = jest.fn();
    const src = createPsyArxivSource({ fetchFn, minIntervalMs: 0 });
    expect(await src.search('   ', 5)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails soft: a phrase request error keeps the phrases already gathered', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse({ data: [rec('ok', 'O', 'a')] }))
      .mockReturnValueOnce(Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as unknown as Response));
    const src = createPsyArxivSource({ fetchFn, minIntervalMs: 0 });
    expect((await src.search('good\nbad', 10)).map((p) => p.sourceId)).toEqual(['osf:ok']);
  });

  it('hydrate is identity', async () => {
    const src = new PsyArxivSource({ fetchFn: jest.fn(), minIntervalMs: 0 });
    const p = psy('osf:x');
    await expect(src.hydrate(p)).resolves.toBe(p);
  });

  it('fullText walks preprint → primary_file → download and parses the PDF', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse({ data: { relationships: { primary_file: { links: { related: { href: 'https://api.osf.io/v2/files/f1/' } } } } } }))
      .mockReturnValueOnce(jsonResponse({ data: { links: { download: 'https://osf.io/download/f1' } } }))
      .mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, headers: { get: () => '9' }, arrayBuffer: async () => new Uint8Array([1, 2]).buffer } as unknown as Response));
    const src = createPsyArxivSource({ fetchFn, minIntervalMs: 0, parsePdf: async () => 'PSY BODY' });

    expect(await src.fullText(psy('osf:guid1'))).toBe('PSY BODY');
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://api.osf.io/v2/preprints/guid1/');
  });
});
