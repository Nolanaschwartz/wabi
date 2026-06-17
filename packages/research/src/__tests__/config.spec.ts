import { loadSourceConfig, sourceMaxTextChars } from '../config';

const KEYS = [
  'RESEARCH_WINDOW_DAYS', 'RESEARCH_MAX_RECORDS', 'RESEARCH_MIN_TERM_FRACTION',
  'RESEARCH_MAX_PDF_BYTES', 'RESEARCH_MAX_TEXT_CHARS',
  'RESEARCH_MEDRXIV_MAX_RECORDS', 'RESEARCH_PSYARXIV_MAX_RECORDS', 'RESEARCH_PSYARXIV_MAX_PDF_BYTES',
  'RESEARCH_PUBMED_MAX_TEXT_CHARS',
];

describe('loadSourceConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('returns the built-in defaults when no env is set', () => {
    expect(loadSourceConfig('medrxiv')).toEqual({
      windowDays: 60, maxRecords: 1500, minTermFraction: 0.5, maxPdfBytes: 20_000_000, maxTextChars: 50_000,
    });
  });

  it('a shared RESEARCH_<KEY> applies to every source', () => {
    process.env.RESEARCH_MAX_RECORDS = '500';
    expect(loadSourceConfig('medrxiv').maxRecords).toBe(500);
    expect(loadSourceConfig('psyarxiv').maxRecords).toBe(500);
  });

  it('a per-source RESEARCH_<KIND>_<KEY> overrides the shared value', () => {
    process.env.RESEARCH_MAX_RECORDS = '500';
    process.env.RESEARCH_PSYARXIV_MAX_RECORDS = '900';
    expect(loadSourceConfig('medrxiv').maxRecords).toBe(500);  // shared
    expect(loadSourceConfig('psyarxiv').maxRecords).toBe(900); // override wins
  });

  it('falls back to default for empty/invalid values (not 0)', () => {
    process.env.RESEARCH_MAX_PDF_BYTES = '';
    expect(loadSourceConfig('psyarxiv').maxPdfBytes).toBe(20_000_000);
  });

  it('sourceMaxTextChars shares the RESEARCH_MAX_TEXT_CHARS fallback across sources incl. pubmed', () => {
    process.env.RESEARCH_MAX_TEXT_CHARS = '1234';
    expect(sourceMaxTextChars('pubmed')).toBe(1234);
    expect(sourceMaxTextChars('medrxiv')).toBe(1234);
    process.env.RESEARCH_PUBMED_MAX_TEXT_CHARS = '99';
    expect(sourceMaxTextChars('pubmed')).toBe(99); // per-source override
  });
});
