import { STOPWORDS, contentTerms, escapeRegExp, idf, minMatch, scoreRecord, weightedScore } from '../term-match';

describe('term-match', () => {
  describe('contentTerms', () => {
    it('lowercases and keeps tokens of length >= 3 that are not stopwords', () => {
      expect(contentTerms('Emotion Regulation Competitive Gaming')).toEqual([
        'emotion',
        'regulation',
        'competitive',
        'gaming',
      ]);
    });

    it('drops stopwords and short (<3 char) tokens', () => {
      // 'after' is a stopword; 'of' is short. Both removed; the rest survive in order.
      expect(contentTerms('rumination after loss of cognitive reappraisal')).toEqual([
        'rumination',
        'loss',
        'cognitive',
        'reappraisal',
      ]);
    });

    it('splits on non-word characters (hyphens, punctuation)', () => {
      expect(contentTerms('self-control, well-being!')).toEqual(['self', 'control', 'well', 'being']);
    });

    it('falls back to the raw tokens when everything is filtered out', () => {
      // All tokens are stopwords or too short -> filtered set is empty -> return raw tokens.
      expect(contentTerms('and the of')).toEqual(['and', 'the', 'of']);
    });
  });

  describe('STOPWORDS', () => {
    it('contains the generic connective/structural words dropped from queries', () => {
      for (const w of ['and', 'for', 'the', 'with', 'study', 'effect']) {
        expect(STOPWORDS.has(w)).toBe(true);
      }
      expect(STOPWORDS.has('rumination')).toBe(false);
    });
  });

  describe('escapeRegExp', () => {
    it('escapes regex metacharacters so they match literally', () => {
      expect(escapeRegExp('a.b*c+(d)')).toBe('a\\.b\\*c\\+\\(d\\)');
    });

    it('leaves plain words untouched', () => {
      expect(escapeRegExp('gaming')).toBe('gaming');
    });
  });

  describe('minMatch', () => {
    it('requires ALL terms when there are 2 or fewer (already specific)', () => {
      expect(minMatch(1, 0.5)).toBe(1);
      expect(minMatch(2, 0.5)).toBe(2);
    });

    it('requires a fraction (min 2) when there are more than 2 terms', () => {
      // 3 terms * 0.5 = 1.5 -> ceil 2, floored to min 2.
      expect(minMatch(3, 0.5)).toBe(2);
      // 4 terms * 0.5 = 2 -> 2.
      expect(minMatch(4, 0.5)).toBe(2);
      // 5 terms * 0.5 = 2.5 -> ceil 3.
      expect(minMatch(5, 0.5)).toBe(3);
    });

    it('never drops below 2 even for a tiny fraction with many terms', () => {
      // 6 terms * 0.1 = 0.6 -> ceil 1, raised to min 2.
      expect(minMatch(6, 0.1)).toBe(2);
    });
  });

  describe('scoreRecord', () => {
    it('counts whole-word matches of the query terms in the text', () => {
      const text = 'Emotion regulation in competitive settings';
      expect(scoreRecord(text, ['emotion', 'regulation', 'competitive', 'gaming'])).toBe(3);
    });

    it('matches whole words only — "term" does not match inside "determine"', () => {
      expect(scoreRecord('we determine the outcome', ['term'])).toBe(0);
      expect(scoreRecord('the term is defined', ['term'])).toBe(1);
    });

    it('is case-insensitive on the text', () => {
      expect(scoreRecord('TILT Regulation', ['tilt', 'regulation'])).toBe(2);
    });

    it('returns 0 when no terms match', () => {
      expect(scoreRecord('orthopedic recovery', ['emotion', 'regulation'])).toBe(0);
    });
  });

  describe('idf', () => {
    it('weights a rare term above a term common across the corpus', () => {
      // "cognitive" is in every doc; "rumination" in one. The rare term must score higher.
      const docs = ['cognitive decline', 'cognitive therapy', 'cognitive rumination'];
      const w = idf(['cognitive', 'rumination'], docs);
      expect(w.get('rumination')!).toBeGreaterThan(w.get('cognitive')!);
    });

    it('keeps every weight strictly positive (smoothed), even a term in every doc', () => {
      const w = idf(['cognitive'], ['cognitive a', 'cognitive b']);
      expect(w.get('cognitive')!).toBeGreaterThan(0);
    });

    it('matches whole words only when counting document frequency', () => {
      // "term" appears as a whole word in 1 of 2 docs (not inside "determine").
      const w = idf(['term'], ['we determine x', 'the term y']);
      const wOnce = idf(['z'], ['the z y', 'a z b']); // z in both docs → more common → lower weight
      expect(w.get('term')!).toBeGreaterThan(wOnce.get('z')!);
    });
  });

  describe('weightedScore', () => {
    it('sums the idf weights of the matched terms', () => {
      const weights = new Map([['rumination', 5], ['cognitive', 1]]);
      expect(weightedScore('cognitive rumination spiral', ['rumination', 'cognitive'], weights)).toBe(6);
    });

    it('a single rare-term match outranks several common-term matches', () => {
      const weights = new Map([['rumination', 5], ['cognitive', 1], ['loss', 1]]);
      const rare = weightedScore('rumination only', ['rumination', 'cognitive', 'loss'], weights);
      const common = weightedScore('cognitive loss', ['rumination', 'cognitive', 'loss'], weights);
      expect(rare).toBeGreaterThan(common);
    });

    it('counts whole words only and treats missing weights as 0', () => {
      const weights = new Map([['term', 3]]);
      expect(weightedScore('we determine', ['term', 'unknown'], weights)).toBe(0);
      expect(weightedScore('the term', ['term', 'unknown'], weights)).toBe(3);
    });
  });
});
