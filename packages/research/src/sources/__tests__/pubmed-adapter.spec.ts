import { pubmedQuery } from '../query/pubmed-adapter';

describe('pubmedQuery', () => {
  it('OR-s quoted core phrases and never bare-AND-s the topic words', () => {
    const q = pubmedQuery({ core: ['emotion regulation', 'reappraisal'], context: [] });
    expect(q).toBe('("emotion regulation" OR reappraisal) AND humans[MeSH Terms]');
    // the AND-collapse bug would have produced `emotion AND regulation AND reappraisal`
    expect(q).not.toMatch(/emotion AND regulation/);
  });

  it('quotes multi-word phrases but leaves single words bare', () => {
    const q = pubmedQuery({ core: ['rumination', 'repetitive negative thinking'], context: [] });
    expect(q).toContain('"repetitive negative thinking"');
    expect(q).toContain('rumination OR');
  });

  it('drops context entirely — only core mechanism phrases constrain (context was noise-injecting)', () => {
    const q = pubmedQuery({ core: ['emotion regulation'], context: ['video gaming'] });
    expect(q).toBe('("emotion regulation") AND humans[MeSH Terms]');
    expect(q).not.toMatch(/video gaming/); // context never reaches the PubMed term
  });

  it('constrains to human studies via humans[MeSH Terms], not the always-true english[Language]', () => {
    const q = pubmedQuery({ core: ['sleep hygiene'], context: [] });
    expect(q).toBe('("sleep hygiene") AND humans[MeSH Terms]');
    expect(q).not.toMatch(/english\[Language\]/);
  });

  it('returns empty for empty concepts so the caller can fall back to the topic', () => {
    expect(pubmedQuery({ core: [], context: [] })).toBe('');
  });
});
