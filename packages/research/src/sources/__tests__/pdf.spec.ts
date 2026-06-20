import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAndParsePdf, FetchPdfOpts } from '../pdf';

const passthroughSchedule = <T>(fn: () => Promise<T>) => fn();

/** %PDF magic + the given trailing bytes — the guard now requires real PDF bytes before parsing. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const pdfBytes = (...rest: number[]) => new Uint8Array([...PDF_MAGIC, ...rest]);

function pdfResponse(bytes: Uint8Array, contentLength?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? (contentLength ?? null) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function baseOpts(over: Partial<FetchPdfOpts> = {}): FetchPdfOpts {
  return {
    fetchFn: jest.fn().mockResolvedValue(pdfResponse(pdfBytes(1, 2, 3))) as any,
    schedule: passthroughSchedule,
    maxPdfBytes: 1000,
    maxTextChars: 1000,
    parsePdf: jest.fn().mockResolvedValue('  extracted body text  '),
    ...over,
  };
}

describe('fetchAndParsePdf', () => {
  it('returns the trimmed parsed text on the happy path', async () => {
    const text = await fetchAndParsePdf('https://x/paper.pdf', baseOpts());
    expect(text).toBe('extracted body text');
  });

  it('downloads through the caller rate limiter (schedule)', async () => {
    const schedule = jest.fn(<T>(fn: () => Promise<T>) => fn());
    await fetchAndParsePdf('https://x/paper.pdf', baseOpts({ schedule: schedule as any }));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('rejects (null) when Content-Length exceeds maxPdfBytes, without parsing', async () => {
    const parsePdf = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(new Uint8Array([1]), '5000'));
    const text = await fetchAndParsePdf('https://x/big.pdf', baseOpts({ fetchFn: fetchFn as any, maxPdfBytes: 1000, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('rejects (null) when the received byte length exceeds maxPdfBytes (no Content-Length)', async () => {
    const parsePdf = jest.fn();
    const big = new Uint8Array(1500);
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(big)); // no content-length header
    const text = await fetchAndParsePdf('https://x/big.pdf', baseOpts({ fetchFn: fetchFn as any, maxPdfBytes: 1000, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('truncates parsed text to maxTextChars', async () => {
    const parsePdf = jest.fn().mockResolvedValue('x'.repeat(5000));
    const text = await fetchAndParsePdf('https://x/paper.pdf', baseOpts({ maxTextChars: 100, parsePdf }));
    expect(text).toHaveLength(100);
  });

  it('returns null without parsing when the response is not a PDF (e.g. OSF HTML interstitial)', async () => {
    const parsePdf = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(new Uint8Array([0x3c, 0x21, 0x64, 0x6f]))); // "<!do"
    const text = await fetchAndParsePdf('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('fails safe to null on an HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    const text = await fetchAndParsePdf('https://x/missing.pdf', baseOpts({ fetchFn: fetchFn as any }));
    expect(text).toBeNull();
  });

  it('fails safe to null when parsing throws', async () => {
    const parsePdf = jest.fn().mockRejectedValue(new Error('corrupt pdf'));
    const text = await fetchAndParsePdf('https://x/paper.pdf', baseOpts({ parsePdf }));
    expect(text).toBeNull();
  });

  it('returns null when the parsed text is empty/whitespace', async () => {
    const parsePdf = jest.fn().mockResolvedValue('   \n  ');
    const text = await fetchAndParsePdf('https://x/paper.pdf', baseOpts({ parsePdf }));
    expect(text).toBeNull();
  });

  describe('RESEARCH_PDF_DIR archive (temporary)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wabi-pdf-')); process.env.RESEARCH_PDF_DIR = dir; });
    afterEach(() => { delete process.env.RESEARCH_PDF_DIR; rmSync(dir, { recursive: true, force: true }); });

    it('tees the fetched bytes to RESEARCH_PDF_DIR before parsing', async () => {
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(pdfBytes(1, 2, 3)));
      const text = await fetchAndParsePdf('https://medrxiv.org/10.1101/a.b.c.full.pdf', baseOpts({ fetchFn: fetchFn as any }));
      expect(text).toBe('extracted body text'); // parse still happens
      const written = join(dir, 'medrxiv.org_10.1101_a.b.c.full.pdf');
      expect(existsSync(written)).toBe(true);
      expect([...readFileSync(written)]).toEqual([...PDF_MAGIC, 1, 2, 3]);
    });

    it('does not write (and still returns text) when the var is unset', async () => {
      delete process.env.RESEARCH_PDF_DIR;
      const text = await fetchAndParsePdf('https://x/paper.pdf', baseOpts());
      expect(text).toBe('extracted body text');
      expect(existsSync(join(dir, 'x_paper.pdf'))).toBe(false);
    });
  });
});
