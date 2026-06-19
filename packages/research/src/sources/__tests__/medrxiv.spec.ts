import { createMedrxivSource } from '../medrxiv';
import { Paper } from '../../types';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
/** A medRxiv paper as fullText() now takes it — only sourceId is read. */
function med(sourceId: string): Paper {
  return { sourceId, sourceKind: 'medrxiv', title: '', abstract: '', url: '', pubTypes: [], isPreprint: true };
}

describe('MedrxivTool', () => {
  const collection = {
    collection: [
      { doi: '10.1101/2024.01.01.1', title: 'Tilt regulation in esports', abstract: 'emotion regulation reduced tilt', date: '2024-01-01' },
      { doi: '10.1101/2024.01.02.2', title: 'Knee surgery outcomes', abstract: 'orthopedic recovery', date: '2024-01-02' },
    ],
  };

  it('search returns only papers matching query terms, all flagged preprint', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(collection));
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    const papers = await tool.search('tilt regulation', 8);
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toContain('Tilt regulation');
    expect(papers[0].isPreprint).toBe(true);
    expect(papers[0].sourceId).toBe('doi:10.1101/2024.01.01.1');
    expect(papers[0].sourceKind).toBe('medrxiv');
  });

  it('pages through the whole window (cursor advances past the first 100) and dedupes by DOI', async () => {
    const page = (start: number, n: number, total: number) => ({
      messages: [{ total }],
      collection: Array.from({ length: n }, (_, i) => ({
        doi: `10.1101/p.${start + i}`, title: `anxiety study ${start + i}`, abstract: 'anxiety coping', date: '2024-01-01',
      })),
    });
    // 100 on page 0, then 50 on page 100 (last page, < PAGE) -> 150 total, two fetches.
    const fetchFn = jest.fn()
      .mockReturnValueOnce(jsonResponse(page(0, 100, 150)))
      .mockReturnValueOnce(jsonResponse(page(100, 50, 150)));
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    const papers = await tool.search('anxiety', 1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toContain('/100/json'); // cursor advanced
    expect(papers).toHaveLength(150);
  });

  it('caches the window so a second topic does not re-fetch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ messages: [{ total: 1 }], collection: [
      { doi: '10.1101/x.1', title: 'sleep study', abstract: 'sleep hygiene', date: '2024-01-01' },
    ] }));
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    await tool.search('sleep', 8);
    await tool.search('hygiene', 8);
    expect(fetchFn).toHaveBeenCalledTimes(1); // one window fetch reused across both searches
  });

  it('IDF-weights a multi-word query: rare terms carry the match, window-common terms cannot float a paper alone', async () => {
    // emotion+regulation appear in MOST of this window, so IDF down-weights them; 'competitive' is rare.
    const body = { collection: [
      // 'gaming' alone -> 1 term, below threshold -> excluded.
      { doi: '10.1101/a.1', title: 'Gaming habits survey', abstract: 'screen time', date: '2024-01-01' },
      // only the window-COMMON pair (emotion+regulation) -> below half the query's total weight -> excluded.
      { doi: '10.1101/a.2', title: 'Emotion regulation training', abstract: 'reappraisal of feelings', date: '2024-01-02' },
      // adds the RARE 'competitive' -> clears the weight threshold -> kept.
      { doi: '10.1101/a.3', title: 'Emotion regulation in competitive settings', abstract: 'arousal control', date: '2024-01-03' },
    ] };
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(body));
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    const papers = await tool.search('emotion regulation competitive gaming', 8);
    expect(papers.map((p) => p.sourceId)).toEqual(['doi:10.1101/a.3']);
  });

  it('drops stopwords/short tokens so they do not count toward the match threshold', async () => {
    const body = { collection: [
      { doi: '10.1101/b.1', title: 'Rumination and reappraisal', abstract: 'cognitive process', date: '2024-01-01' },
    ] };
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(body));
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    // content terms = [rumination, after, loss, cognitive, reappraisal] minus stopword 'after' = 4 real terms;
    // record hits rumination + reappraisal + cognitive (3) -> passes the half threshold.
    const papers = await tool.search('rumination after loss cognitive reappraisal', 8);
    expect(papers).toHaveLength(1);
    expect(papers[0].sourceId).toBe('doi:10.1101/b.1');
  });

  // Routes search calls to JSON and *.full.pdf calls to a PDF-ish response, so search() can prime
  // the version cache and fullText() can fetch the PDF in the same test.
  function routedFetch(collection: unknown, pdfOk = true) {
    return jest.fn((url: string) => {
      if (url.endsWith('.full.pdf')) {
        if (!pdfOk) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } });
        const bytes = new TextEncoder().encode('%PDF-stub');
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => String(bytes.byteLength) },
          arrayBuffer: async () => bytes.buffer });
      }
      return jsonResponse(collection);
    }) as unknown as jest.MockedFunction<typeof fetch>;
  }

  it('fullText fetches the version-specific PDF and returns its parsed text', async () => {
    const collection = { collection: [
      { doi: '10.1101/2024.05.05.5', title: 'tilt control', abstract: 'tilt regulation', date: '2024-05-05', version: '2' },
    ] };
    const parsePdf = jest.fn().mockResolvedValue('FULL MEDRXIV BODY');
    const fetchFn = routedFetch(collection);
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-05-31'), parsePdf });
    await tool.search('tilt', 8); // primes the version cache

    const text = await tool.fullText(med('doi:10.1101/2024.05.05.5'));

    expect(text).toBe('FULL MEDRXIV BODY');
    const pdfCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('.full.pdf'))!;
    expect(pdfCall[0]).toBe('https://www.medrxiv.org/content/10.1101/2024.05.05.5v2.full.pdf');
  });

  it('fullText uses the latest version when the window holds multiple versions of a doi', async () => {
    // medRxiv returns one row per version (ascending). Dedup-by-doi must keep the HIGHEST version so
    // we mine the current full text, not the superseded v1.
    const collection = { collection: [
      { doi: '10.1101/2024.07.07.7', title: 'reappraisal study', abstract: 'reappraisal', date: '2024-07-01', version: '1' },
      { doi: '10.1101/2024.07.07.7', title: 'reappraisal study', abstract: 'reappraisal', date: '2024-07-08', version: '2' },
    ] };
    const parsePdf = jest.fn().mockResolvedValue('BODY');
    const fetchFn = routedFetch(collection);
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, windowDays: 60, now: () => new Date('2024-07-31'), parsePdf });
    await tool.search('reappraisal', 8); // primes the cache with both version rows

    await tool.fullText(med('doi:10.1101/2024.07.07.7'));

    const pdfCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('.full.pdf'))!;
    expect(pdfCall[0]).toBe('https://www.medrxiv.org/content/10.1101/2024.07.07.7v2.full.pdf');
  });

  it('fullText falls back to v1 when the version is unknown (doi not in the window cache)', async () => {
    const parsePdf = jest.fn().mockResolvedValue('BODY');
    const fetchFn = routedFetch({ collection: [] });
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, parsePdf });

    await tool.fullText(med('doi:10.1101/2024.09.09.9'));

    const pdfCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('.full.pdf'))!;
    expect(pdfCall[0]).toBe('https://www.medrxiv.org/content/10.1101/2024.09.09.9v1.full.pdf');
  });

  it('fullText fails safe to null when the PDF fetch errors (abstract fallback)', async () => {
    const fetchFn = routedFetch({ collection: [] }, false);
    const tool = createMedrxivSource({ fetchFn, minIntervalMs: 0, parsePdf: jest.fn() });
    expect(await tool.fullText(med('doi:10.1101/2024.09.09.9'))).toBeNull();
  });
});
