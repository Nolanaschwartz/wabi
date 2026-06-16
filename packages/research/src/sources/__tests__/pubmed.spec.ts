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

  it('throws on HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    await expect(tool.search('x', 8)).rejects.toThrow('503');
  });
});
