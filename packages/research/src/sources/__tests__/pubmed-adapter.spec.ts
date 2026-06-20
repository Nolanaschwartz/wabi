import { pubmedQuery } from '../query/pubmed-adapter';

describe('pubmedQuery', () => {
  it('OR-s quoted core phrases and never bare-AND-s the topic words', () => {
    const q = pubmedQuery({ core: ['emotion regulation', 'reappraisal'], context: [] });
    expect(q).toBe('("emotion regulation" OR reappraisal) AND (humans[MeSH Terms] OR english[Language])');
    // the AND-collapse bug would have produced `emotion AND regulation AND reappraisal`
    expect(q).not.toMatch(/emotion AND regulation/);
  });

  it('quotes multi-word phrases but leaves single words bare', () => {
    const q = pubmedQuery({ core: ['rumination', 'repetitive negative thinking'], context: [] });
    expect(q).toContain('"repetitive negative thinking"');
    expect(q).toContain('rumination OR');
  });

  it('adds context as a NON-constraining OR clause (never AND), so the domain word cannot exclude', () => {
    const q = pubmedQuery({ core: ['emotion regulation'], context: ['video gaming'] });
    expect(q).toBe('(("emotion regulation") OR ("video gaming")) AND (humans[MeSH Terms] OR english[Language])');
    expect(q).not.toMatch(/AND \("video gaming"\)/); // context is OR-ed, not required
  });

  it('omits the context clause entirely when context is empty', () => {
    const q = pubmedQuery({ core: ['sleep hygiene'], context: [] });
    expect(q).toBe('("sleep hygiene") AND (humans[MeSH Terms] OR english[Language])');
  });

  it('returns empty for empty concepts so the caller can fall back to the topic', () => {
    expect(pubmedQuery({ core: [], context: [] })).toBe('');
  });
});
