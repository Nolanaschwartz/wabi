import { parseMoodRating } from '../mood-rating';

describe('parseMoodRating', () => {
  it.each([
    ['3', 3],
    ['feeling 3 today', 3],
    ["i'm a 2 honestly", 2],
    ['4/5', 4],
    ['rate myself 5', 5],
    ['1', 1],
  ])('extracts a 1–5 rating from %p → %p', (text, expected) => {
    expect(parseMoodRating(text as string)).toBe(expected);
  });

  it.each([
    ['not sure right now'],
    ['10'], // out of 1–5 range, not a standalone digit
    ['feeling like a 100'],
    [''],
    ['0'],
    ['7'],
  ])('returns null when there is no usable 1–5 rating in %p', (text) => {
    expect(parseMoodRating(text as string)).toBeNull();
  });

  // An explicit scale whose denominator is NOT 5 is a different scale, not a 1–5 mood. Reject it
  // rather than mis-logging the numerator (e.g. "2 out of 10" must not become a 2/5 mood).
  it.each([
    ['2 out of 10'],
    ['more like a 2 out of 10 day'],
    ['3/10'],
    ['honestly a 1 out of 100'],
  ])('returns null for a non-/5 scale in %p', (text) => {
    expect(parseMoodRating(text as string)).toBeNull();
  });

  // A /5 scale still resolves to its numerator.
  it.each([
    ['4/5', 4],
    ['5 out of 5', 5],
  ])('reads the numerator of a /5 scale %p → %p', (text, expected) => {
    expect(parseMoodRating(text as string)).toBe(expected);
  });
});
