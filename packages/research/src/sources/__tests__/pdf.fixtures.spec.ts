import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAndParsePdf } from '../pdf';

// Exercises the REAL unpdf parser (no parsePdf stub) against a tiny committed PDF, so a break in
// the ESM dynamic-import path or the unpdf API surface is caught here rather than in production.
describe('fetchAndParsePdf — real unpdf parser', () => {
  it('extracts plain text from a real PDF through the default parser', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.pdf')));
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response);

    const text = await fetchAndParsePdf('https://example.org/sample.pdf', {
      fetchFn: fetchFn as any,
      schedule: (fn) => fn(),
      maxPdfBytes: 1_000_000,
      maxTextChars: 10_000,
    });

    expect(text).toContain('Hello unpdf fixture body');
  }, 30_000);
});
