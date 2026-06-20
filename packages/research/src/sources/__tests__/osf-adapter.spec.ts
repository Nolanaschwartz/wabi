import { osfQuery } from '../query/osf-adapter';

describe('osfQuery', () => {
  it('newline-joins the core phrases (one OSF icontains request each)', () => {
    expect(osfQuery({ core: ['emotion regulation', 'reappraisal'], context: ['gaming'] }))
      .toBe('emotion regulation\nreappraisal');
  });

  it('caps the number of phrases to bound per-topic OSF requests', () => {
    const core = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(osfQuery({ core, context: [] }).split('\n')).toHaveLength(5);
  });

  it('returns empty for empty core so the caller can fall back', () => {
    expect(osfQuery({ core: [], context: [] })).toBe('');
  });
});
