import { PubMedTool } from '../pubmed';
import { Paper } from '../../types';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
}
function textResponse(body: string) {
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
}
/** A thin pubmed hit as search() yields it — the input shape hydrate()/fullText()/expand() take. */
function pm(id: string): Paper {
  return { sourceId: `PMID:${id}`, sourceKind: 'pubmed', title: '', abstract: '',
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}`, pubTypes: [], isPreprint: false };
}

describe('PubMedTool', () => {
  it('search returns thin PMID-prefixed papers from esearch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ esearchresult: { idlist: ['111', '222'] } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const papers = await tool.search('tilt regulation', 8);
    // Thin: id keyspace + url only; the `PMID:` prefix is the canonical seen()/ledger key.
    expect(papers.map((p) => p.sourceId)).toEqual(['PMID:111', 'PMID:222']);
    expect(papers[0]).toMatchObject({ sourceKind: 'pubmed', title: '', abstract: '', isPreprint: false,
      url: 'https://pubmed.ncbi.nlm.nih.gov/111' });
    expect(fetchFn.mock.calls[0][0]).toContain('esearch.fcgi');
    expect(fetchFn.mock.calls[0][0]).toContain('retmax=8');
    expect(fetchFn.mock.calls[0][0]).toContain('sort=relevance'); // best matches across history, not most-recent
  });

  it('hydrate fills title/pubTypes/abstract from esummary + efetch, keeping the sourceId', async () => {
    const fetchFn = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('esummary.fcgi')) {
        return { ok: true, status: 200, json: async () => ({
          result: { '111': { uid: '111', title: 'PMR and anxiety', pubtype: ['Randomized Controlled Trial'] } },
        }), text: async () => '' } as Response;
      }
      if (u.includes('efetch.fcgi')) {
        return { ok: true, status: 200, text: async () => 'PMR reduced state anxiety in a trial.', json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected url ${u}`);
    });
    const tool = new PubMedTool({ fetchFn: fetchFn as unknown as typeof fetch, minIntervalMs: 0 });
    const p = await tool.hydrate(pm('111'));
    expect(p.title).toBe('PMR and anxiety');
    expect(p.pubTypes).toEqual(['Randomized Controlled Trial']);
    expect(p.abstract).toContain('PMR reduced state anxiety');
    expect(p.sourceId).toBe('PMID:111'); // identity on the id keyspace
  });

  it('expand returns citation-graph neighbours as thin PMID papers', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({
      linksets: [{ linksetdbs: [{ links: ['333', '444'] }] }],
    }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const papers = await tool.expand(pm('111'));
    expect(papers.map((p) => p.sourceId)).toEqual(['PMID:333', 'PMID:444']);
    expect(papers.every((p) => p.sourceKind === 'pubmed' && p.abstract === '')).toBe(true);
  });

  it('fullText returns null when the paper is not open-access (no PMCID)', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ result: { '111': { uid: '111', articleids: [] } } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.fullText(pm('111'))).toBeNull();
  });

  it('fullText fetches BioC with the PMC-prefixed id and parses the top-level array (real API shape)', async () => {
    // Real esummary returns the pmc id WITH the "PMC" prefix; real BioC returns a top-level ARRAY
    // ([collection]) whose collection.documents[].passages[].text hold the body. Verified against
    // the live NCBI APIs — both shapes the original code got wrong.
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(
        jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }),
      )
      .mockReturnValueOnce(
        jsonResponse([
          {
            bioctype: 'BioCCollection',
            documents: [{ passages: [{ text: 'Background: occupational stress.' }, { text: 'Method: PMR protocol.' }] }],
          },
        ]),
      );
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const text = await tool.fullText(pm('111'));
    expect(text).toContain('occupational stress');
    expect(text).toContain('PMR protocol');
    // The BioC URL must keep the PMC prefix — stripping it returns "[Error] : No result can be found".
    expect(fetchFn.mock.calls[1][0]).toContain('/BioC_json/PMC8314311/unicode');
  });

  it('fullText falls back to Europe PMC OA full text when BioC yields nothing', async () => {
    const fetchFn = jest
      .fn()
      // esummary -> PMCID known
      .mockReturnValueOnce(jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }))
      // BioC -> empty collection (no passages) => biocText null, so the fallback fires
      .mockReturnValueOnce(jsonResponse([{ documents: [] }]))
      // Europe PMC fullTextXML
      .mockReturnValueOnce(textResponse('<article><body><sec><p>Mindfulness reduced rumination.</p></sec></body></article>'));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });

    const text = await tool.fullText(pm('111'));

    expect(text).toBe('Mindfulness reduced rumination.');
    expect(fetchFn.mock.calls[2][0]).toContain('/europepmc/webservices/rest/PMC8314311/fullTextXML');
  });

  it('fullText does NOT call Europe PMC when BioC already returned text', async () => {
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }))
      .mockReturnValueOnce(jsonResponse([{ documents: [{ passages: [{ text: 'BioC body present.' }] }] }]));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });

    expect(await tool.fullText(pm('111'))).toBe('BioC body present.');
    expect(fetchFn).toHaveBeenCalledTimes(2); // no Europe PMC fetch
  });

  it('fullText strips XML tags and truncates the result to maxTextChars', async () => {
    const longBody = '<p>' + 'word '.repeat(1000) + '</p>';
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }))
      .mockReturnValueOnce(jsonResponse([{ documents: [] }]))
      .mockReturnValueOnce(textResponse(longBody));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0, maxTextChars: 50 });

    const text = await tool.fullText(pm('111'));

    expect(text).toHaveLength(50);
    expect(text).not.toContain('<');
  });

  it('fullText fails safe to null when both BioC and Europe PMC fail', async () => {
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }))
      .mockReturnValueOnce(jsonResponse([{ documents: [] }])) // BioC empty
      .mockReturnValueOnce(Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) })); // Europe PMC 404
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });

    expect(await tool.fullText(pm('111'))).toBeNull();
  });

  it('fullText returns null when the BioC body is a non-JSON error (not yet in BioC)', async () => {
    // Very recent OA papers return a non-JSON "[Error]" body with HTTP 200 — json() throws → null.
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(
        jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC9999999' }] } } }),
      )
      .mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token E');
          },
          text: async () => '[Error] : No result can be found.',
        }),
      );
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.fullText(pm('111'))).toBeNull();
  });

  it('summarize fetches titles for many PMIDs in one esummary call', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ result: {
      uids: ['111', '222'],
      '111': { uid: '111', title: 'First' },
      '222': { uid: '222', title: 'Second' },
    }}));
    const src = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const out = await src.summarize!(['PMID:111', 'PMID:222']);
    expect(out).toEqual([{ id: 'PMID:111', title: 'First' }, { id: 'PMID:222', title: 'Second' }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toMatch(/esummary\.fcgi.*id=111,222/);
  });

  it('summarize returns [] on fetch error (fail-open)', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('network error'));
    const src = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const out = await src.summarize!(['PMID:111']);
    expect(out).toEqual([]);
  });

  it('summarize filters out entries with empty titles', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ result: {
      uids: ['111', '222'],
      '111': { uid: '111', title: '' },
      '222': { uid: '222', title: 'Second' },
    }}));
    const src = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const out = await src.summarize!(['PMID:111', 'PMID:222']);
    expect(out).toEqual([{ id: 'PMID:222', title: 'Second' }]);
  });

  it('summarize returns [] for empty id list', async () => {
    const fetchFn = jest.fn();
    const src = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await src.summarize!([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws on a 4xx HTTP error (not retried)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '', json: async () => ({}) });
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    await expect(tool.search('x', 8)).rejects.toThrow('400');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx and recovers rather than zeroing the topic', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '', json: async () => ({}) })
      .mockReturnValueOnce(jsonResponse({ esearchresult: { idlist: ['111'] } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const papers = await tool.search('x', 8);
    expect(papers.map((p) => p.sourceId)).toEqual(['PMID:111']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
