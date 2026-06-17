import { ratingToEmoji, MOOD_EMOJIS } from '../mood';

describe('ratingToEmoji', () => {
  it('maps each rating 1-5 to its canonical emoji', () => {
    expect(ratingToEmoji(1)).toBe('😞');
    expect(ratingToEmoji(2)).toBe('😔');
    expect(ratingToEmoji(3)).toBe('😐');
    expect(ratingToEmoji(4)).toBe('🙂');
    expect(ratingToEmoji(5)).toBe('😊');
  });

  it('falls back to the neutral face for out-of-range ratings', () => {
    expect(ratingToEmoji(0)).toBe('😐');
    expect(ratingToEmoji(6)).toBe('😐');
    expect(ratingToEmoji(-1)).toBe('😐');
  });

  it('exposes the raw map keyed by rating', () => {
    expect(MOOD_EMOJIS).toEqual({ 1: '😞', 2: '😔', 3: '😐', 4: '🙂', 5: '😊' });
  });
});
