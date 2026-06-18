import { WindowedPreprintSource, PreprintSpec } from '../windowed-preprint-source';
import { Paper, SourceKind } from '../../types';

// A trivial raw-record shape for the fake spec. `version` stands in for the per-source extra that
// pdfUrl reads off the record (medRxiv reads exactly this).
interface FakeRec { id: string; title: string; abstract: string; version?: string }

function rec(id: string, title: string, abstract: string, version?: string): FakeRec {
  return { id, title, abstract, version };
}

/** A fake spec over FakeRec. Counts fetchWindow calls (to prove the window is cached) and records the
 * record pdfUrl was handed (to prove the cache lookup), so the core can be tested with no HTTP. */
function fakeSpec(records: FakeRec[]) {
  let fetchCalls = 0;
  let pdfSawRecord: FakeRec | undefined | 'unset' = 'unset';
  const spec: PreprintSpec<FakeRec> = {
    kind: 'medrxiv' as SourceKind,
    async fetchWindow(_from, _to, _ctx) {
      fetchCalls++;
      return records;
    },
    toPaper(r) {
      return {
        sourceId: `fake:${r.id}`,
        sourceKind: 'medrxiv',
        title: r.title,
        abstract: r.abstract,
        url: `https://example.test/${r.id}`,
        pubTypes: [],
        isPreprint: true,
      };
    },
    async pdfUrl(paper, record, _ctx) {
      pdfSawRecord = record;
      return record ? `https://pdf.test/${record.id}` : `https://pdf.test/FALLBACK/${paper.sourceId}`;
    },
  };
  return { spec, fetchCalls: () => fetchCalls, pdfSawRecord: () => pdfSawRecord };
}

const FIXED_NOW = new Date('2026-06-01T00:00:00Z');

describe('WindowedPreprintSource', () => {
  it('fetches the window once and reuses it across topics', async () => {
    const f = fakeSpec([rec('1', 'Box breathing', 'a breathing technique')]);
    const src = new WindowedPreprintSource(f.spec, { minIntervalMs: 0, now: () => FIXED_NOW });

    await src.search('breathing', 5);
    await src.search('something else entirely', 5);

    expect(f.fetchCalls()).toBe(1);
  });

  it('keeps records matching enough query terms, ranked by score, capped to the limit', async () => {
    const f = fakeSpec([
      rec('a', 'Box breathing exercise', 'a breathing technique'), // breathing+exercise+technique = 3
      rec('b', 'Cognitive reframing', 'changing thoughts'), //                                       = 0
      rec('c', 'Deep breathing', 'a breathing exercise'), //               breathing+exercise         = 2
    ]);
    const src = new WindowedPreprintSource(f.spec, { minIntervalMs: 0, now: () => FIXED_NOW });

    const papers = await src.search('breathing exercise technique', 5);

    expect(papers.map((p) => p.sourceId)).toEqual(['fake:a', 'fake:c']); // b dropped (0 terms), a outranks c
  });

  it('respects the limit', async () => {
    const f = fakeSpec([
      rec('a', 'Box breathing exercise', 'a breathing technique'),
      rec('c', 'Deep breathing', 'a breathing exercise'),
    ]);
    const src = new WindowedPreprintSource(f.spec, { minIntervalMs: 0, now: () => FIXED_NOW });

    const papers = await src.search('breathing exercise technique', 1);

    expect(papers).toHaveLength(1);
    expect(papers[0].sourceId).toBe('fake:a');
  });

  it('hydrate is the identity (preprint list endpoints return complete papers)', async () => {
    const f = fakeSpec([]);
    const src = new WindowedPreprintSource(f.spec, { minIntervalMs: 0, now: () => FIXED_NOW });
    const paper: Paper = {
      sourceId: 'fake:x', sourceKind: 'medrxiv', title: 't', abstract: 'a',
      url: 'u', pubTypes: [], isPreprint: true,
    };
    await expect(src.hydrate(paper)).resolves.toBe(paper);
  });

  it('fullText looks the record up from the primed window and delegates to the shared PDF parse', async () => {
    const f = fakeSpec([rec('1', 'Box breathing', 'a breathing technique', '3')]);
    let fetchedUrl = '';
    const fetchFn = (async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => '10' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch;
    const src = new WindowedPreprintSource(f.spec, {
      minIntervalMs: 0,
      now: () => FIXED_NOW,
      fetchFn: (async (u: string) => { fetchedUrl = u; return (fetchFn as any)(u); }) as unknown as typeof fetch,
      parsePdf: async () => 'FULLTEXT BODY',
    });

    await src.search('breathing', 5); // primes the window cache
    const text = await src.fullText({
      sourceId: 'fake:1', sourceKind: 'medrxiv', title: 'Box breathing',
      abstract: 'a breathing technique', url: 'u', pubTypes: [], isPreprint: true,
    });

    expect(text).toBe('FULLTEXT BODY');
    expect(f.pdfSawRecord()).toMatchObject({ id: '1', version: '3' }); // looked up the raw record
    expect(fetchedUrl).toBe('https://pdf.test/1');
  });

  it('fullText hands pdfUrl an undefined record when the paper was never in the window', async () => {
    const f = fakeSpec([rec('1', 'Box breathing', 'a breathing technique')]);
    const fetchFn = (async () => ({
      ok: true, status: 200, headers: { get: () => '10' },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    })) as unknown as typeof fetch;
    const src = new WindowedPreprintSource(f.spec, {
      minIntervalMs: 0, now: () => FIXED_NOW, fetchFn, parsePdf: async () => 'X',
    });

    // No search() first, so the cache is empty.
    await src.fullText({
      sourceId: 'fake:unknown', sourceKind: 'medrxiv', title: 't',
      abstract: 'a', url: 'u', pubTypes: [], isPreprint: true,
    });

    expect(f.pdfSawRecord()).toBeUndefined();
  });

  it('exposes the spec kind', () => {
    const f = fakeSpec([]);
    const src = new WindowedPreprintSource(f.spec, { minIntervalMs: 0 });
    expect(src.kind).toBe('medrxiv');
  });
});
