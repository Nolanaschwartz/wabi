/**
 * Canonical mood rating → emoji mapping.
 *
 * Single source of truth shared by the bot (DM capture replies) and the web
 * dashboard (mood calendar). A rating is the 1-5 scale a person logs; the emoji
 * is its face. Keep this the ONLY place the mapping is defined so the two
 * surfaces can never drift.
 */

export const MOOD_EMOJIS: Record<number, string> = {
  1: '😞',
  2: '😔',
  3: '😐',
  4: '🙂',
  5: '😊',
};

/** Map a 1-5 rating to its emoji; anything out of range falls back to neutral. */
export function ratingToEmoji(rating: number): string {
  return MOOD_EMOJIS[rating] ?? '😐';
}
