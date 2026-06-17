import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PsyArxivTool } from '../psyarxiv';

/**
 * Validates the OSF full-text chain against RECORDED LIVE response shapes (captured 2026-06-17 from
 * api.osf.io for preprint `wpt5b_v2`) and exercises the REAL unpdf parser end-to-end. If OSF changes
 * the `primary_file` → file-node → `links.download` path, or the unpdf API/ESM-load breaks, this
 * fixtures spec catches it rather than production.
 */
const PREPRINT_GUID = 'wpt5b_v2';
const FILE_NODE_URL = 'https://api.osf.io/v2/files/6a314ddb5be89e01ec9451bc/';
const DOWNLOAD_URL = 'https://osf.io/download/6a314ddb5be89e01ec9451bc/';

// Trimmed to the fields PsyArxivTool reads, but the path structure is verbatim from the live API.
const PREPRINT_DETAIL = {
  data: {
    id: PREPRINT_GUID,
    type: 'preprints',
    relationships: {
      primary_file: { links: { related: { href: FILE_NODE_URL, meta: {} } }, data: { id: '6a314ddb5be89e01ec9451bc', type: 'files' } },
    },
  },
};
const FILE_NODE = {
  data: {
    id: '6a314ddb5be89e01ec9451bc',
    type: 'files',
    attributes: { name: 'BavardGluth_draft.pdf', size: 1306585 },
    links: { download: DOWNLOAD_URL, html: 'https://osf.io/6a314ddb5be89e01ec9451bc', self: FILE_NODE_URL },
  },
};

describe('PsyArxivTool.fullText — recorded OSF shapes + real unpdf', () => {
  it('walks preprint → primary_file → download and extracts real PDF text', async () => {
    const pdfBytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.pdf')));
    const fetchFn = jest.fn((url: string) => {
      if (url === `https://api.osf.io/v2/preprints/${PREPRINT_GUID}/`) {
        return Promise.resolve({ ok: true, status: 200, json: async () => PREPRINT_DETAIL } as unknown as Response);
      }
      if (url === FILE_NODE_URL) {
        return Promise.resolve({ ok: true, status: 200, json: async () => FILE_NODE } as unknown as Response);
      }
      if (url === DOWNLOAD_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => String(pdfBytes.byteLength) },
          arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } } as unknown as Response);
    }) as unknown as jest.MockedFunction<typeof fetch>;

    // No parsePdf override -> uses the default unpdf parser.
    const tool = new PsyArxivTool({ fetchFn, minIntervalMs: 0 });
    const text = await tool.fullText(`osf:${PREPRINT_GUID}`);

    expect(text).toContain('Hello unpdf fixture body');
  }, 30_000);
});
