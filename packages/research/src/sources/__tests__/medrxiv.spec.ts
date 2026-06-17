import { MedrxivTool } from '../medrxiv';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
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
    const tool = new MedrxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
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
    const tool = new MedrxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    const papers = await tool.search('anxiety', 1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toContain('/100/json'); // cursor advanced
    expect(papers).toHaveLength(150);
  });

  it('caches the window so a second topic does not re-fetch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ messages: [{ total: 1 }], collection: [
      { doi: '10.1101/x.1', title: 'sleep study', abstract: 'sleep hygiene', date: '2024-01-01' },
    ] }));
    const tool = new MedrxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    await tool.search('sleep', 8);
    await tool.search('hygiene', 8);
    expect(fetchFn).toHaveBeenCalledTimes(1); // one window fetch reused across both searches
  });

  it('fullText returns null in v1 (abstract is read instead)', async () => {
    const tool = new MedrxivTool({ fetchFn: jest.fn(), minIntervalMs: 0 });
    expect(await tool.fullText('doi:10.1101/2024.01.01.1')).toBeNull();
  });
});
