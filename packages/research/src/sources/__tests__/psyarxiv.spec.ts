import { PsyArxivTool } from '../psyarxiv';
import { Paper } from '../../types';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
/** A PsyArXiv paper as fullText() now takes it — only sourceId is read. */
function psy(sourceId: string): Paper {
  return { sourceId, sourceKind: 'psyarxiv', title: '', abstract: '', url: '', pubTypes: [], isPreprint: true };
}

// Minimal slice of the real OSF API v2 preprints response shape (verified live):
// { data: [{ id: <guid>, attributes: { title, description, date_published } }], links: { next } }
function rec(id: string, title: string, description: string) {
  return { id, type: 'preprints', attributes: { title, description, date_published: '2026-06-01T00:00:00' } };
}
function page(records: ReturnType<typeof rec>[], next: string | null = null) {
  return { data: records, links: { next }, meta: { version: '2.0' } };
}

describe('PsyArxivTool', () => {
  it('maps OSF records to Paper with osf:<guid> id, psyarxiv kind, and preprint flag', async () => {
    const body = page([
      rec('abc12', 'Emotion regulation in gamers', 'reappraisal reduces tilt'),
      rec('xyz99', 'Knee surgery outcomes', 'orthopedic recovery'),
    ]);
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(body));
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2026-06-17') });

    const papers = await tool.search('emotion regulation', 8);

    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      sourceId: 'osf:abc12',
      sourceKind: 'psyarxiv',
      title: 'Emotion regulation in gamers',
      abstract: 'reappraisal reduces tilt',
      url: 'https://osf.io/abc12',
      pubTypes: [],
      isPreprint: true,
    });
  });

  it('follows links.next and dedups records by guid across pages', async () => {
    const next = 'https://api.osf.io/v2/preprints/?page=2';
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse(page([rec('a', 'anxiety coping', 'anxiety study'), rec('b', 'anxiety habits', 'anxiety')], next)))
      // 'a' repeats on page 2 -> deduped; only 'c' is new.
      .mockReturnValueOnce(jsonResponse(page([rec('a', 'anxiety coping', 'anxiety study'), rec('c', 'anxiety relief', 'anxiety')], null)));
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2026-06-17') });

    const papers = await tool.search('anxiety', 1000);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe(next); // second fetch used the next link verbatim
    expect(papers.map((p) => p.sourceId).sort()).toEqual(['osf:a', 'osf:b', 'osf:c']);
  });

  it('keeps following links.next even when an intermediate page is entirely duplicates', async () => {
    // OSF sorts by -date_published; records sharing a date can re-appear across a page boundary,
    // so an all-duplicate page is NOT a reliable end-of-window signal — only a null `next` is.
    const next1 = 'https://api.osf.io/v2/preprints/?page=2';
    const next2 = 'https://api.osf.io/v2/preprints/?page=3';
    const dup = [rec('a', 'anxiety one', 'anxiety'), rec('b', 'anxiety two', 'anxiety')];
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse(page(dup, next1)))
      .mockReturnValueOnce(jsonResponse(page(dup, next2)))                                   // all duplicates
      .mockReturnValueOnce(jsonResponse(page([rec('c', 'anxiety three', 'anxiety')], null))); // fresh record beyond
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2026-06-17') });

    const papers = await tool.search('anxiety', 1000);

    expect(fetchFn).toHaveBeenCalledTimes(3); // did not stop at the all-duplicate page
    expect(papers.map((p) => p.sourceId).sort()).toEqual(['osf:a', 'osf:b', 'osf:c']);
  });

  it('stops paging once maxRecords is reached', async () => {
    const next = 'https://api.osf.io/v2/preprints/?page=2';
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse(page([rec('a', 'sleep hygiene', 'sleep'), rec('b', 'sleep timing', 'sleep')], next)))
      .mockReturnValueOnce(jsonResponse(page([rec('c', 'sleep more', 'sleep')], null)));
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, maxRecords: 2, now: () => new Date('2026-06-17') });

    await tool.search('sleep', 1000);

    expect(fetchFn).toHaveBeenCalledTimes(1); // cap hit after page 1; never followed next
  });

  it('caches the window so a second topic in the same run does not refetch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(page([rec('a', 'sleep hygiene', 'sleep quality')])));
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2026-06-17') });

    await tool.search('sleep', 8);
    await tool.search('hygiene', 8);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ranks kept papers by how many query content-terms they match', async () => {
    const body = page([
      rec('one', 'Gaming habits survey', 'screen time'), // 1 of 4 -> below threshold -> excluded
      rec('two', 'Emotion regulation training', 'reappraisal of feelings'), // emotion+regulation = 2 -> kept
      rec('three', 'Emotion regulation in competitive settings', 'arousal control'), // 3 -> kept, ranked first
    ]);
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(body));
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2026-06-17') });

    const papers = await tool.search('emotion regulation competitive gaming', 8);

    expect(papers.map((p) => p.sourceId)).toEqual(['osf:three', 'osf:two']);
  });

  it('sends an Authorization: Bearer header only when a token is configured', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(page([rec('a', 'sleep study', 'sleep')])));
    const withToken = new PsyArxivTool({ fetchFn, token: 'secret-tok', minIntervalMs: 0, now: () => new Date('2026-06-17') });
    await withToken.search('sleep', 8);
    expect((fetchFn.mock.calls[0][1] as any)?.headers?.Authorization).toBe('Bearer secret-tok');

    const fetchFn2 = jest.fn().mockReturnValue(jsonResponse(page([rec('a', 'sleep study', 'sleep')])));
    const noToken = new PsyArxivTool({ fetchFn: fetchFn2, minIntervalMs: 0, now: () => new Date('2026-06-17') });
    await noToken.search('sleep', 8);
    expect((fetchFn2.mock.calls[0][1] as any)?.headers?.Authorization).toBeUndefined();
  });

  // Routes the OSF full-text chain: preprint detail -> file node -> PDF download.
  function fullTextFetch(opts: { fileHref?: string | null; downloadUrl?: string | null; pdfOk?: boolean } = {}) {
    const fileHref = 'fileHref' in opts ? opts.fileHref : 'https://api.osf.io/v2/files/F1/';
    const downloadUrl = 'downloadUrl' in opts ? opts.downloadUrl : 'https://osf.io/download/F1/';
    return jest.fn((url: string) => {
      if (url === 'https://api.osf.io/v2/preprints/g1/') {
        return jsonResponse({ data: { relationships: { primary_file: fileHref ? { links: { related: { href: fileHref } } } : {} } } });
      }
      if (url === fileHref) {
        return jsonResponse({ data: { links: downloadUrl ? { download: downloadUrl } : {} } });
      }
      if (url === downloadUrl) {
        if (opts.pdfOk === false) return Promise.resolve({ ok: false, status: 500, headers: { get: () => null } });
        const bytes = new TextEncoder().encode('%PDF-psy');
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => String(bytes.byteLength) }, arrayBuffer: async () => bytes.buffer });
      }
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } });
    }) as unknown as jest.MockedFunction<typeof fetch>;
  }

  it('fullText resolves guid -> primary_file -> download URL and returns parsed text', async () => {
    const parsePdf = jest.fn().mockResolvedValue('PSYARXIV FULL BODY');
    const fetchFn = fullTextFetch();
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0, parsePdf });

    const text = await tool.fullText(psy('osf:g1'));

    expect(text).toBe('PSYARXIV FULL BODY');
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://api.osf.io/v2/preprints/g1/'); // detail
    expect(urls).toContain('https://api.osf.io/v2/files/F1/');      // file node
    expect(urls).toContain('https://osf.io/download/F1/');          // download
  });

  it('fullText fails safe to null when the preprint has no primary_file', async () => {
    const tool = new PsyArxivTool({ fetchFn: fullTextFetch({ fileHref: null }), minIntervalMs: 0, parsePdf: jest.fn() });
    expect(await tool.fullText(psy('osf:g1'))).toBeNull();
  });

  it('fullText fails safe to null when the file node has no download link', async () => {
    const tool = new PsyArxivTool({ fetchFn: fullTextFetch({ downloadUrl: null }), minIntervalMs: 0, parsePdf: jest.fn() });
    expect(await tool.fullText(psy('osf:g1'))).toBeNull();
  });

  it('fullText fails safe to null when the PDF download errors', async () => {
    const tool = new PsyArxivTool({ fetchFn: fullTextFetch({ pdfOk: false }), minIntervalMs: 0, parsePdf: jest.fn() });
    expect(await tool.fullText(psy('osf:g1'))).toBeNull();
  });
});
