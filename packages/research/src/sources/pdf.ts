import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger, noopLogger } from '../util/logger';

// ponytail: temporary local PDF archive. When RESEARCH_PDF_DIR is set, tee each fetched PDF to disk
// before parsing — best-effort, a write failure never affects parsing. Env read lazily (populated by
// ConfigModule after import). Unset the var to turn it off; remove this when the debug need passes.
async function archivePdf(url: string, bytes: Uint8Array, log: Logger): Promise<void> {
  const dir = process.env.RESEARCH_PDF_DIR;
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const base = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    await writeFile(join(dir, base.endsWith('.pdf') ? base : `${base}.pdf`), bytes);
  } catch (e) {
    log.info('pdf archive failed', { url, err: (e as Error)?.message ?? String(e) });
  }
}

export interface FetchPdfOpts {
  fetchFn: typeof fetch;
  schedule: <T>(fn: () => Promise<T>) => Promise<T>; // the calling tool's RateLimiter.schedule
  maxPdfBytes: number;
  maxTextChars: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;   // default: unpdf extractText, pages joined "\n"
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

/**
 * Fetch a PDF and return capped plain text, or `null` on ANY failure (HTTP, oversize, parse error,
 * empty) so the caller falls back to the abstract — matching the `pubmed.fullText` contract. Shared
 * by medRxiv and PsyArXiv so they can't drift in how they cap, parse, and fail-safe.
 */
export async function fetchAndParsePdf(url: string, opts: FetchPdfOpts): Promise<string | null> {
  const log = opts.log ?? noopLogger;
  const parse = opts.parsePdf ?? unpdfParse;
  try {
    const bytes = await opts.schedule(async () => {
      const res = await opts.fetchFn(url);
      if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
      // Reject early on the server's declared size, before buffering the body.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxPdfBytes) {
        throw new Error(`PDF too large (declared ${declared} > ${opts.maxPdfBytes})`);
      }
      const u8 = new Uint8Array(await res.arrayBuffer());
      // Re-check against the actual received length (Content-Length may be absent or lie).
      if (u8.byteLength > opts.maxPdfBytes) {
        throw new Error(`PDF too large (received ${u8.byteLength} > ${opts.maxPdfBytes})`);
      }
      return u8;
    });

    await archivePdf(url, bytes, log); // tee to disk when RESEARCH_PDF_DIR is set (temporary)
    // OSF's /download often serves an HTML interstitial/redirect rather than the file; parsing those
    // bytes throws "Invalid PDF structure" and wastes the work. Gate on the %PDF magic so a non-PDF
    // response falls back to the abstract cleanly (and silently) instead.
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      log.info('pdf skipped: response is not a PDF', { url, bytes: bytes.byteLength });
      return null;
    }
    const text = (await parse(bytes)).trim().slice(0, opts.maxTextChars);
    return text.length > 0 ? text : null;
  } catch (e) {
    log.info('pdf fetch/parse failed', { url, err: (e as Error)?.message ?? String(e) });
    return null;
  }
}
