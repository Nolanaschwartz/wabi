import { ALL_LENSES, lensesForTier } from '../lenses';

describe('lensesForTier', () => {
  it('runs all five lenses for peer-reviewed tiers', () => {
    for (const tier of ['meta-analysis', 'systematic-review', 'rct', 'observational'] as const) {
      expect(lensesForTier(tier)).toEqual(ALL_LENSES);
    }
  });
  it('runs only the behavioral + cognitive subset for preprints (precision-leaning)', () => {
    expect(lensesForTier('preprint')).toEqual(['behavioral', 'cognitive']);
  });
});
