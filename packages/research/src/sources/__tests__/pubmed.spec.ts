import { PubMedTool } from '../pubmed';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
}
function textResponse(body: string) {
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
}

describe('PubMedTool', () => {
  it('search returns PMIDs from esearch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ esearchresult: { idlist: ['111', '222'] } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.search('tilt regulation', 8)).toEqual(['111', '222']);
    expect(fetchFn.mock.calls[0][0]).toContain('esearch.fcgi');
    expect(fetchFn.mock.calls[0][0]).toContain('retmax=8');
  });

  it('summary returns title + pubTypes from esummary', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({
      result: { '111': { uid: '111', title: 'PMR and anxiety', pubtype: ['Randomized Controlled Trial'] } },
    }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const s = await tool.summary('111');
    expect(s).toEqual({ title: 'PMR and anxiety', pubTypes: ['Randomized Controlled Trial'] });
  });

  it('abstract returns efetch text', async () => {
    const fetchFn = jest.fn().mockReturnValue(textResponse('PMR reduced state anxiety in a trial.'));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.abstract('111')).toContain('PMR reduced state anxiety');
  });

  it('related returns neighbor PMIDs from elink', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({
      linksets: [{ linksetdbs: [{ links: ['333', '444'] }] }],
    }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.related('111')).toEqual(['333', '444']);
  });

  it('fullText returns null when the paper is not open-access (no PMCID)', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ result: { '111': { uid: '111', articleids: [] } } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.fullText('111')).toBeNull();
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
    const text = await tool.fullText('111');
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

    const text = await tool.fullText('111');

    expect(text).toBe('Mindfulness reduced rumination.');
    expect(fetchFn.mock.calls[2][0]).toContain('/europepmc/webservices/rest/PMC8314311/fullTextXML');
  });

  it('fullText does NOT call Europe PMC when BioC already returned text', async () => {
    const fetchFn = jest
      .fn()
      .mockReturnValueOnce(jsonResponse({ result: { '111': { uid: '111', articleids: [{ idtype: 'pmc', value: 'PMC8314311' }] } } }))
      .mockReturnValueOnce(jsonResponse([{ documents: [{ passages: [{ text: 'BioC body present.' }] }] }]));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });

    expect(await tool.fullText('111')).toBe('BioC body present.');
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

    const text = await tool.fullText('111');

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

    expect(await tool.fullText('111')).toBeNull();
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
    expect(await tool.fullText('111')).toBeNull();
  });

  it('throws on HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    await expect(tool.search('x', 8)).rejects.toThrow('503');
  });
});
