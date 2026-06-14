/**
 * Pull a 1–5 mood rating out of a free-text DM reply ("3", "feeling 3", "i'm a 2", "4/5"). Returns the
 * first standalone 1–5 digit, or null when there is none — `\b` boundaries mean multi-digit numbers like
 * "10" or "100" never match a stray 1–5. Used by the mood spoke to capture the rating turn.
 *
 * An explicit scale ("X/Y" or "X out of Y") is honoured first: a /5 scale resolves to its numerator,
 * but any other denominator is a DIFFERENT scale ("2 out of 10", "3/10") and is rejected rather than
 * mis-logging the numerator as a 1–5 mood. This is the dominant capture-turn false positive.
 */
export function parseMoodRating(text: string): number | null {
  const scale = text.match(/\b(\d+)\s*(?:\/|out of)\s*(\d+)\b/i);
  if (scale) {
    const num = Number(scale[1]);
    return scale[2] === '5' && num >= 1 && num <= 5 ? num : null;
  }
  const match = text.match(/\b([1-5])\b/);
  return match ? Number(match[1]) : null;
}
