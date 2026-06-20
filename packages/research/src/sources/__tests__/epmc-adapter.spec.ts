import { epmcQuery } from '../query/epmc-adapter';

describe('epmcQuery', () => {
  it('OR-s core phrases across TITLE and ABSTRACT, quoting multi-word phrases', () => {
    const q = epmcQuery({ core: ['emotion regulation', 'reappraisal'], context: [] });
    expect(q).toBe('(TITLE:"emotion regulation" OR TITLE:reappraisal OR ABSTRACT:"emotion regulation" OR ABSTRACT:reappraisal)');
  });

  it('folds context phrases in as additional (non-constraining) OR terms', () => {
    const q = epmcQuery({ core: ['sleep'], context: ['gaming'] });
    expect(q).toContain('TITLE:gaming');
    expect(q).toContain('ABSTRACT:gaming');
    expect(q).not.toMatch(/AND/); // never AND — the caller appends the SRC:PPR facet
  });

  it('returns empty for empty concepts so the caller can fall back', () => {
    expect(epmcQuery({ core: [], context: [] })).toBe('');
  });
});
