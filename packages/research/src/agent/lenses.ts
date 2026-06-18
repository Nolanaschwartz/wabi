import { EvidenceTier, Lens } from '../types';

/** The five extraction lenses, in fan-out order. */
export const ALL_LENSES: Lens[] = ['behavioral', 'cognitive', 'social', 'environmental', 'physiological'];

/** Preprints are mined with a narrower, precision-leaning subset (slice 03/05 tiering). */
export const PREPRINT_LENSES: Lens[] = ['behavioral', 'cognitive'];

/** Tier-scaled lens set: full breadth for peer-reviewed work, the subset for not-yet-reviewed preprints. */
export function lensesForTier(tier: EvidenceTier): Lens[] {
  return tier === 'preprint' ? PREPRINT_LENSES : ALL_LENSES;
}
