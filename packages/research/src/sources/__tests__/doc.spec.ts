import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAndParseDoc, FetchDocOpts } from '../doc';

const passthroughSchedule = <T>(fn: () => Promise<T>) => fn();

/** %PDF magic + the given trailing bytes — the guard now requires real PDF bytes before parsing. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const pdfBytes = (...rest: number[]) => new Uint8Array([...PDF_MAGIC, ...rest]);

/** PK\x03\x04 — the ZIP/DOCX magic; a `.docx` is an OOXML zip. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const zipBytes = (...rest: number[]) => new Uint8Array([...ZIP_MAGIC, ...rest]);

function pdfResponse(bytes: Uint8Array, contentLength?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? (contentLength ?? null) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function baseOpts(over: Partial<FetchDocOpts> = {}): FetchDocOpts {
  return {
    fetchFn: jest.fn().mockResolvedValue(pdfResponse(pdfBytes(1, 2, 3))) as any,
    schedule: passthroughSchedule,
    maxDocBytes: 1000,
    maxTextChars: 1000,
    parsePdf: jest.fn().mockResolvedValue('  extracted body text  '),
    ...over,
  };
}

describe('fetchAndParseDoc', () => {
  it('returns the trimmed parsed text on the happy path', async () => {
    const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts());
    expect(text).toBe('extracted body text');
  });

  it('downloads through the caller rate limiter (schedule)', async () => {
    const schedule = jest.fn(<T>(fn: () => Promise<T>) => fn());
    await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ schedule: schedule as any }));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('rejects (null) when Content-Length exceeds maxDocBytes, without parsing', async () => {
    const parsePdf = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(new Uint8Array([1]), '5000'));
    const text = await fetchAndParseDoc('https://x/big.pdf', baseOpts({ fetchFn: fetchFn as any, maxDocBytes: 1000, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('rejects (null) when the received byte length exceeds maxDocBytes (no Content-Length)', async () => {
    const parsePdf = jest.fn();
    const big = new Uint8Array(1500);
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(big)); // no content-length header
    const text = await fetchAndParseDoc('https://x/big.pdf', baseOpts({ fetchFn: fetchFn as any, maxDocBytes: 1000, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('caps an oversized streamed body incrementally (aborts before draining the whole stream)', async () => {
    const parsePdf = jest.fn();
    let pulled = 0;
    async function* body() {
      const first = new Uint8Array(400); first.set(PDF_MAGIC, 0); // carries %PDF magic
      pulled++; yield first;
      for (let i = 0; i < 50; i++) { pulled++; yield new Uint8Array(400); } // 50*400 = 20KB, cap is 1000
    }
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => null }, // no Content-Length — the early declared-size reject can't fire
      body: body(),
      arrayBuffer: async () => { throw new Error('must not buffer the whole body'); },
    } as unknown as Response;
    const fetchFn = jest.fn().mockResolvedValue(res);
    const text = await fetchAndParseDoc('https://x/big.pdf', baseOpts({ fetchFn: fetchFn as any, maxDocBytes: 1000, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
    expect(pulled).toBeGreaterThan(0); // it streamed (the old arrayBuffer path never touches body)
    expect(pulled).toBeLessThan(10);   // and aborted early — did NOT drain all 51 chunks into memory
  });

  it('hands the parser a plain Uint8Array (not a Buffer) on the streamed success path', async () => {
    // unpdf's extractText rejects a Buffer ("provide binary data as Uint8Array"). Buffer.concat
    // returns a Buffer, so the streaming path must normalise to a plain Uint8Array.
    let received: unknown;
    const parsePdf = jest.fn(async (buf: Uint8Array) => { received = buf; return 'ok'; });
    async function* body() { const b = new Uint8Array(8); b.set(PDF_MAGIC, 0); yield b; }
    const res = {
      ok: true, status: 200,
      headers: { get: () => null },
      body: body(),
      arrayBuffer: async () => { throw new Error('must not buffer the whole body'); },
    } as unknown as Response;
    const fetchFn = jest.fn().mockResolvedValue(res);
    await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ fetchFn: fetchFn as any, parsePdf }));
    expect(received).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(received)).toBe(false);
  });

  it('truncates parsed text to maxTextChars', async () => {
    const parsePdf = jest.fn().mockResolvedValue('x'.repeat(5000));
    const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ maxTextChars: 100, parsePdf }));
    expect(text).toHaveLength(100);
  });

  it('returns null without parsing when the response is not a PDF (e.g. OSF HTML interstitial)', async () => {
    const parsePdf = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue(pdfResponse(new Uint8Array([0x3c, 0x21, 0x64, 0x6f]))); // "<!do"
    const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parsePdf }));
    expect(text).toBeNull();
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('fails safe to null on an HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    const text = await fetchAndParseDoc('https://x/missing.pdf', baseOpts({ fetchFn: fetchFn as any }));
    expect(text).toBeNull();
  });

  it('fails safe to null when parsing throws', async () => {
    const parsePdf = jest.fn().mockRejectedValue(new Error('corrupt pdf'));
    const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ parsePdf }));
    expect(text).toBeNull();
  });

  it('returns null when the parsed text is empty/whitespace', async () => {
    const parsePdf = jest.fn().mockResolvedValue('   \n  ');
    const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ parsePdf }));
    expect(text).toBeNull();
  });

  describe('format dispatch (PDF vs DOCX)', () => {
    it('routes a DOCX (PK/ZIP) response to parseDocx, not parsePdf', async () => {
      const parsePdf = jest.fn();
      const parseDocx = jest.fn().mockResolvedValue('  docx body text  ');
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(zipBytes(1, 2, 3)));
      const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parsePdf, parseDocx }));
      expect(text).toBe('docx body text');
      expect(parseDocx).toHaveBeenCalledTimes(1);
      expect(parsePdf).not.toHaveBeenCalled();
    });

    it('routes a PDF (%PDF) response to parsePdf, not parseDocx', async () => {
      const parsePdf = jest.fn().mockResolvedValue('pdf body text');
      const parseDocx = jest.fn();
      const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts({ parsePdf, parseDocx }));
      expect(text).toBe('pdf body text');
      expect(parseDocx).not.toHaveBeenCalled();
    });

    it('returns null for an unsupported format (neither %PDF nor PK), invoking neither parser', async () => {
      const parsePdf = jest.fn();
      const parseDocx = jest.fn();
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(new Uint8Array([0x3c, 0x21, 0x64, 0x6f]))); // "<!do"
      const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parsePdf, parseDocx }));
      expect(text).toBeNull();
      expect(parsePdf).not.toHaveBeenCalled();
      expect(parseDocx).not.toHaveBeenCalled();
    });

    it('fails safe to null when the DOCX parser throws (non-Word ZIP, e.g. .xlsx)', async () => {
      const parseDocx = jest.fn().mockRejectedValue(new Error('not a Word document'));
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(zipBytes(0xff, 0xff)));
      const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parseDocx }));
      expect(text).toBeNull();
    });

    it('returns null when the parsed DOCX text is empty/whitespace', async () => {
      const parseDocx = jest.fn().mockResolvedValue('   \n  ');
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(zipBytes(1)));
      const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, parseDocx }));
      expect(text).toBeNull();
    });

    it('truncates parsed DOCX text to maxTextChars', async () => {
      const parseDocx = jest.fn().mockResolvedValue('y'.repeat(5000));
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(zipBytes(1)));
      const text = await fetchAndParseDoc('https://osf.io/download/x/', baseOpts({ fetchFn: fetchFn as any, maxTextChars: 100, parseDocx }));
      expect(text).toHaveLength(100);
    });
  });

  describe('RESEARCH_PDF_DIR archive (temporary)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wabi-pdf-')); process.env.RESEARCH_PDF_DIR = dir; });
    afterEach(() => { delete process.env.RESEARCH_PDF_DIR; rmSync(dir, { recursive: true, force: true }); });

    it('tees the fetched bytes to RESEARCH_PDF_DIR before parsing', async () => {
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(pdfBytes(1, 2, 3)));
      const text = await fetchAndParseDoc('https://medrxiv.org/10.1101/a.b.c.full.pdf', baseOpts({ fetchFn: fetchFn as any }));
      expect(text).toBe('extracted body text'); // parse still happens
      const written = join(dir, 'medrxiv.org_10.1101_a.b.c.full.pdf');
      expect(existsSync(written)).toBe(true);
      expect([...readFileSync(written)]).toEqual([...PDF_MAGIC, 1, 2, 3]);
    });

    it('archives a DOCX response with a .docx suffix (format-aware)', async () => {
      const fetchFn = jest.fn().mockResolvedValue(pdfResponse(zipBytes(1, 2, 3)));
      const parseDocx = jest.fn().mockResolvedValue('docx body');
      await fetchAndParseDoc('https://osf.io/download/abc/', baseOpts({ fetchFn: fetchFn as any, parseDocx }));
      const written = join(dir, 'osf.io_download_abc_.docx');
      expect(existsSync(written)).toBe(true);
      expect([...readFileSync(written)]).toEqual([...ZIP_MAGIC, 1, 2, 3]);
    });

    it('does not write (and still returns text) when the var is unset', async () => {
      delete process.env.RESEARCH_PDF_DIR;
      const text = await fetchAndParseDoc('https://x/paper.pdf', baseOpts());
      expect(text).toBe('extracted body text');
      expect(existsSync(join(dir, 'x_paper.pdf'))).toBe(false);
    });
  });
});
