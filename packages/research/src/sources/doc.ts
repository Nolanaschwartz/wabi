import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger, noopLogger } from '../util/logger';

// ponytail: temporary local document archive. When RESEARCH_PDF_DIR is set, tee each fetched doc to
// disk before parsing — best-effort, a write failure never affects parsing. Now archives docx too (the
// env name stays RESEARCH_PDF_DIR — a live debug knob, not worth a breaking rename). Env read lazily
// (populated by ConfigModule after import). Unset the var to turn it off; remove when the debug need passes.
async function archiveDoc(url: string, bytes: Uint8Array, log: Logger): Promise<void> {
  const dir = process.env.RESEARCH_PDF_DIR;
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const ext = `.${detectFormat(bytes) ?? 'bin'}`; // .pdf / .docx / .bin, by magic bytes
    const base = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    await writeFile(join(dir, base.endsWith(ext) ? base : `${base}${ext}`), bytes);
  } catch (e) {
    log.info('doc archive failed', { url, err: (e as Error)?.message ?? String(e) });
  }
}

export interface FetchDocOpts {
  fetchFn: typeof fetch;
  schedule: <T>(fn: () => Promise<T>) => Promise<T>; // the calling tool's RateLimiter.schedule
  maxDocBytes: number;
  maxTextChars: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;   // default: unpdf extractText, pages joined "\n"
  parseDocx?: (buf: Uint8Array) => Promise<string>;  // default: mammoth extractRawText
  log?: Logger;
}

/** Default PDF→text: unpdf's `extractText` (serverless PDF.js), pages joined with newlines.
 * unpdf ships a CommonJS build, so we `require` it lazily here — deferring the heavy PDF.js load
 * until a PDF is actually parsed. unpdf then dynamically `import()`s its serverless PDF.js bundle;
 * that works natively under plain Node (production), but Jest's VM needs
 * `NODE_OPTIONS=--experimental-vm-modules` (set in this package's test script) to allow it. */
async function unpdfParse(buf: Uint8Array): Promise<string> {
  const { extractText } = require('unpdf') as typeof import('unpdf');
  const { text } = await extractText(buf);
  return Array.isArray(text) ? text.join('\n') : String(text ?? '');
}

/** Default DOCX→text: mammoth's `extractRawText`. mammoth is CommonJS, so we `require` it lazily here
 * (deferring the load until a Word doc is actually parsed) and hand it a Node `Buffer` — it does not
 * accept a bare Uint8Array. A non-Word ZIP (.xlsx/.pptx/plain zip) throws, which the caller catches
 * and turns into a null → abstract fallback, so no pre-sniffing of `word/document.xml` is needed. */
// ponytail: extractRawText runs CPU-bound zip-inflate + XML parse synchronously on the event loop,
// and the byte cap bounds the *download* not the *decompression* (a crafted docx could inflate huge).
// Same property as the existing unpdf path; reputable academic sources make this low-risk. Upgrade
// path if it ever bites: run extraction in a worker thread / add a decompressed-size guard.
async function mammothParse(buf: Uint8Array): Promise<string> {
  const mammoth = require('mammoth') as typeof import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return value ?? '';
}

/** Read the response body, enforcing the byte cap as chunks arrive so a headerless oversized
 * download is aborted (the stream is cancelled) before the whole body is buffered. Falls back to
 * arrayBuffer() when the runtime gives no streamable body (e.g. a mocked Response in tests). */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const u8 = new Uint8Array(await res.arrayBuffer());
    if (u8.byteLength > maxBytes) throw new Error(`doc too large (received ${u8.byteLength} > ${maxBytes})`);
    return u8;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`doc too large (streamed > ${maxBytes})`); // throwing cancels the stream
    chunks.push(chunk);
  }
  // Concat into a *plain* Uint8Array, not a Buffer: unpdf's extractText rejects Buffer
  // ("provide binary data as Uint8Array"). mammoth (Buffer.from) accepts either.
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Detect the supported document format from the leading magic bytes, or null for anything else
 * (HTML interstitials, RTF, .doc, empty bodies) — which falls back to the abstract. */
function detectFormat(bytes: Uint8Array): 'pdf' | 'docx' | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'docx'; // PK\x03\x04 (ZIP)
  return null;
}

/**
 * Fetch a document and return capped plain text, or `null` on ANY failure (HTTP, oversize, parse error,
 * empty) so the caller falls back to the abstract — matching the `pubmed.fullText` contract. Shared
 * by Europe PMC and PsyArXiv so they can't drift in how they cap, parse, and fail-safe.
 */
export async function fetchAndParseDoc(url: string, opts: FetchDocOpts): Promise<string | null> {
  const log = opts.log ?? noopLogger;
  try {
    const bytes = await opts.schedule(async () => {
      const res = await opts.fetchFn(url);
      if (!res.ok) throw new Error(`doc HTTP ${res.status}`);
      // Reject early on the server's declared size, before buffering the body.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxDocBytes) {
        throw new Error(`doc too large (declared ${declared} > ${opts.maxDocBytes})`);
      }
      // Enforce the cap as bytes arrive (Content-Length may be absent or lie) so a headerless
      // oversized download aborts before the whole body is buffered — the always-on worker must
      // not OOM on a single fetch.
      return readCapped(res, opts.maxDocBytes);
    });

    await archiveDoc(url, bytes, log); // tee to disk when RESEARCH_PDF_DIR is set (temporary)
    // OSF's /download often serves an HTML interstitial/redirect rather than the file; parsing those
    // bytes wastes work. Dispatch by magic bytes: %PDF → unpdf, PK/ZIP → mammoth (DOCX), anything else
    // → abstract fallback (cleanly and silently).
    const format = detectFormat(bytes);
    if (!format) {
      log.info('doc skipped: unsupported format', { url, bytes: bytes.byteLength, magic: Buffer.from(bytes.subarray(0, 4)).toString('hex') });
      return null;
    }
    const parse = format === 'pdf' ? (opts.parsePdf ?? unpdfParse) : (opts.parseDocx ?? mammothParse);
    const text = (await parse(bytes)).trim().slice(0, opts.maxTextChars);
    return text.length > 0 ? text : null;
  } catch (e) {
    log.info('doc fetch/parse failed', { url, err: (e as Error)?.message ?? String(e) });
    return null;
  }
}
