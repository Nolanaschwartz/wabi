import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAndParseDoc } from '../doc';

// Exercises the REAL unpdf/mammoth parsers (no stub) against tiny committed fixtures, so a break in
// the ESM dynamic-import path or either library's API surface is caught here rather than in production.

function fixtureResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('fetchAndParseDoc — real parsers', () => {
  it('extracts plain text from a real PDF through the default unpdf parser', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.pdf')));
    const fetchFn = jest.fn().mockResolvedValue(fixtureResponse(bytes));

    const text = await fetchAndParseDoc('https://example.org/sample.pdf', {
      fetchFn: fetchFn as any,
      schedule: (fn) => fn(),
      maxDocBytes: 1_000_000,
      maxTextChars: 10_000,
    });

    expect(text).toContain('Hello unpdf fixture body');
  }, 30_000);

  it('extracts plain text from a real DOCX through the default mammoth parser', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample.docx')));
    const fetchFn = jest.fn().mockResolvedValue(fixtureResponse(bytes));

    const text = await fetchAndParseDoc('https://osf.io/download/sample/', {
      fetchFn: fetchFn as any,
      schedule: (fn) => fn(),
      maxDocBytes: 1_000_000,
      maxTextChars: 10_000,
    });

    expect(text).toContain('Hello mammoth fixture body');
  }, 30_000);
});
