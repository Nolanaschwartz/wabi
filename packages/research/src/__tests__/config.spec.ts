import { sourceMaxTextChars } from '../config';

const KEYS = ['RESEARCH_MAX_TEXT_CHARS', 'RESEARCH_PUBMED_MAX_TEXT_CHARS'];

describe('sourceMaxTextChars', () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('shares the RESEARCH_MAX_TEXT_CHARS fallback across sources incl. pubmed', () => {
    process.env.RESEARCH_MAX_TEXT_CHARS = '1234';
    expect(sourceMaxTextChars('pubmed')).toBe(1234);
    expect(sourceMaxTextChars('medrxiv')).toBe(1234);
    process.env.RESEARCH_PUBMED_MAX_TEXT_CHARS = '99';
    expect(sourceMaxTextChars('pubmed')).toBe(99); // per-source override
  });
});
