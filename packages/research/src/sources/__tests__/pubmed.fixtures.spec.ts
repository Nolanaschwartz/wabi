import { readFileSync } from 'fs';
import { join } from 'path';
import { PubMedTool } from '../pubmed';

// These specs replay REAL responses captured from the live NCBI E-utilities + BioC APIs
// (see ./fixtures/README.md and ../../../scripts/capture-fixtures.sh). Unlike hand-written mocks,
// a captured fixture encodes the API's ACTUAL shape — so a parser that assumes the wrong shape
// fails here, offline and deterministically. This file exists because hand-written mocks hid two
// real fullText bugs (BioC returns a top-level array, and the endpoint needs the PMC-prefixed id).
//
// Fixtures are coherent around one stable open-access paper: PMID 34542434 / PMC8314311.

const FIX = join(__dirname, 'fixtures');
function read(name: string): string {
  return readFileSync(join(FIX, name), 'utf8');
}

/** A fetch that serves the captured fixture matching each E-utility/BioC URL. */
function fixtureFetch(over: Record<string, string> = {}): jest.Mock {
  return jest.fn(async (url: unknown) => {
    const u = String(url);
    const file =
      over.elink && u.includes('elink.fcgi')
        ? over.elink
        : u.includes('esearch.fcgi')
          ? 'esearch.json'
          : u.includes('esummary.fcgi')
            ? 'esummary.json'
            : u.includes('efetch.fcgi')
              ? 'efetch-abstract.txt'
              : u.includes('elink.fcgi')
                ? 'elink.json'
                : u.includes('BioC_json')
                  ? 'bioc.json'
                  : null;
    if (!file) throw new Error(`fixtureFetch: no fixture for ${u}`);
    const raw = read(file);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(raw),
      text: async () => raw,
    } as Response;
  });
}

describe('PubMedTool against real captured fixtures', () => {
  it('search parses the real esearch idlist', async () => {
    const tool = new PubMedTool({ fetchFn: fixtureFetch() as unknown as typeof fetch, minIntervalMs: 0 });
    const ids = await tool.search('progressive muscle relaxation anxiety', 3);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  });

  it('summary extracts title + pubTypes from the real esummary shape', async () => {
    const tool = new PubMedTool({ fetchFn: fixtureFetch() as unknown as typeof fetch, minIntervalMs: 0 });
    const s = await tool.summary('34542434');
    expect(s.title).toContain('Mindfulness');
    expect(Array.isArray(s.pubTypes)).toBe(true);
  });

  it('abstract returns the raw efetch blob (NOTE: includes citation/DOI metadata, not just the abstract)', async () => {
    const tool = new PubMedTool({ fetchFn: fixtureFetch() as unknown as typeof fetch, minIntervalMs: 0 });
    const abs = await tool.abstract('34542434');
    expect(abs.length).toBeGreaterThan(100);
    // Documents the known limitation: efetch text is a metadata-laden blob, so `extract` is fed
    // the citation header + DOI alongside the abstract. If `abstract()` is ever changed to parse
    // out the abstract proper, this assertion should be inverted.
    expect(abs.toLowerCase()).toMatch(/doi:|author information|©|copyright/);
  });

  it('related parses neighbor PMIDs from the real elink shape (and includes the query PMID itself)', async () => {
    const tool = new PubMedTool({ fetchFn: fixtureFetch() as unknown as typeof fetch, minIntervalMs: 0 });
    const rel = await tool.related('34542434');
    expect(rel.length).toBeGreaterThan(10);
    expect(rel.every((id) => /^\d+$/.test(id))).toBe(true);
    // Quirk worth pinning: elink's neighbor list contains the source PMID; the agent's visited-set
    // dedup relies on this not causing a re-process.
    expect(rel).toContain('34542434');
  });

  it('related returns [] on the real NCBI 200-with-ERROR elink shape (fail-safe)', async () => {
    const tool = new PubMedTool({
      fetchFn: fixtureFetch({ elink: 'elink-error.json' }) as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await tool.related('34542434')).toEqual([]);
  });

  // THE regression that the hand-written mock missed: real BioC is a top-level array and the
  // endpoint needs the PMC-prefixed id. This replays the real 126KB BioC response end-to-end.
  it('fullText parses the real BioC top-level array into non-empty body text', async () => {
    const fetchFn = fixtureFetch();
    const tool = new PubMedTool({ fetchFn: fetchFn as unknown as typeof fetch, minIntervalMs: 0 });
    const text = await tool.fullText('34542434');
    expect(text).not.toBeNull();
    expect((text as string).length).toBeGreaterThan(5000);
    expect(text as string).toContain('Psychological Flexibility');
    // URL must keep the PMC prefix.
    const biocCall = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('BioC_json'));
    expect(biocCall).toContain('/BioC_json/PMC8314311/');
  });
});

// Opt-in LIVE drift detection — hits the real APIs to catch shape changes the fixtures can't.
// Skipped by default (network + rate limits); run with: RESEARCH_LIVE=1 pnpm -F @wabi/research test -- pubmed.fixtures
const live = process.env.RESEARCH_LIVE === '1' ? describe : describe.skip;
live('PubMed LIVE drift (RESEARCH_LIVE=1)', () => {
  it('real esearch still returns a numeric idlist array', async () => {
    const tool = new PubMedTool({ apiKey: process.env.NCBI_API_KEY, minIntervalMs: 1500 });
    const ids = await tool.search('progressive muscle relaxation anxiety', 2);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  }, 30000);

  it('real fullText still parses to non-empty text for a known OA paper', async () => {
    const tool = new PubMedTool({ apiKey: process.env.NCBI_API_KEY, minIntervalMs: 2000 });
    const text = await tool.fullText('34542434');
    expect(text && text.length).toBeGreaterThan(1000);
  }, 30000);
});
