import { sourceMaxTextChars, sourceMaxDocBytes } from '../config';

const KEYS = [
  'RESEARCH_MAX_TEXT_CHARS', 'RESEARCH_PUBMED_MAX_TEXT_CHARS',
  'RESEARCH_MAX_DOC_BYTES', 'RESEARCH_PSYARXIV_MAX_DOC_BYTES',
];

describe('sourceMaxTextChars', () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('shares the RESEARCH_MAX_TEXT_CHARS fallback across sources incl. pubmed', () => {
    process.env.RESEARCH_MAX_TEXT_CHARS = '1234';
    expect(sourceMaxTextChars('pubmed')).toBe(1234);
    expect(sourceMaxTextChars('europepmc')).toBe(1234);
    process.env.RESEARCH_PUBMED_MAX_TEXT_CHARS = '99';
    expect(sourceMaxTextChars('pubmed')).toBe(99); // per-source override
  });
});

describe('sourceMaxDocBytes', () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to 20MB when no env var is set', () => {
    expect(sourceMaxDocBytes('psyarxiv')).toBe(20_000_000);
  });

  it('honors the shared RESEARCH_MAX_DOC_BYTES, with a per-source override', () => {
    process.env.RESEARCH_MAX_DOC_BYTES = '5000';
    expect(sourceMaxDocBytes('psyarxiv')).toBe(5000);
    expect(sourceMaxDocBytes('europepmc')).toBe(5000);
    process.env.RESEARCH_PSYARXIV_MAX_DOC_BYTES = '7000';
    expect(sourceMaxDocBytes('psyarxiv')).toBe(7000); // per-source override
    expect(sourceMaxDocBytes('europepmc')).toBe(5000); // others keep the shared value
  });
});
