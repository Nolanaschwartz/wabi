import { readFileSync } from 'fs';
import { join } from 'path';
import { MedrxivTool } from '../medrxiv';

// Replays a REAL medRxiv details-window response (./fixtures/medrxiv-details.json, 100 records
// captured from the live API). Pins the actual record shape the local-filter depends on, so a
// field rename (doi/title/abstract/date) or a top-level-shape change fails here, offline.

const FIX = join(__dirname, 'fixtures');

function fixtureFetch(): jest.Mock {
  const raw = readFileSync(join(FIX, 'medrxiv-details.json'), 'utf8');
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse(raw) }) as Response);
}

describe('MedrxivTool against a real captured fixture', () => {
  it('search filters the real collection by query terms and flags every hit as a preprint', async () => {
    const tool = new MedrxivTool({
      fetchFn: fixtureFetch() as unknown as typeof fetch,
      minIntervalMs: 0,
      // The injected clock/window don't matter here — the mock returns the fixture regardless of URL.
      windowDays: 30,
      now: () => new Date('2024-01-06'),
    });
    // "Plasmodium falciparum" appears verbatim in a real record's title in the captured window.
    const papers = await tool.search('plasmodium falciparum', 8);
    expect(papers.length).toBeGreaterThan(0);
    for (const p of papers) {
      expect(p.isPreprint).toBe(true);
      expect(p.sourceKind).toBe('medrxiv');
      expect(p.sourceId.startsWith('doi:')).toBe(true);
      expect(p.url).toContain('medrxiv.org');
      const hay = `${p.title} ${p.abstract}`.toLowerCase();
      expect(hay).toContain('plasmodium');
      expect(hay).toContain('falciparum');
    }
  });

  it('returns [] when no record in the real window matches the query terms', async () => {
    const tool = new MedrxivTool({ fetchFn: fixtureFetch() as unknown as typeof fetch, minIntervalMs: 0 });
    // Pure gibberish content terms — none appear as whole words in any real abstract.
    expect(await tool.search('zxqwvb plokmnq vbnmqwz', 8)).toEqual([]);
  });
});

// Opt-in LIVE drift detection. Skipped by default; RESEARCH_LIVE=1 to run.
const live = process.env.RESEARCH_LIVE === '1' ? describe : describe.skip;
live('medRxiv LIVE drift (RESEARCH_LIVE=1)', () => {
  it('real details window still returns records with the expected fields', async () => {
    const tool = new MedrxivTool({ minIntervalMs: 1000, windowDays: 30 });
    const papers = await tool.search('anxiety', 3);
    // Coverage varies by window, but the shape must hold: any hit is a well-formed preprint Paper.
    for (const p of papers) {
      expect(p.isPreprint).toBe(true);
      expect(p.sourceId.startsWith('doi:')).toBe(true);
      expect(typeof p.abstract).toBe('string');
    }
  }, 30000);
});
