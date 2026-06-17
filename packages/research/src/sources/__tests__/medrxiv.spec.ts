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

  it('fullText returns null in v1 (abstract is read instead)', async () => {
    const tool = new MedrxivTool({ fetchFn: jest.fn(), minIntervalMs: 0 });
    expect(await tool.fullText('doi:10.1101/2024.01.01.1')).toBeNull();
  });
});
