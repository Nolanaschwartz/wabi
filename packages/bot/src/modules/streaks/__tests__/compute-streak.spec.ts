import { computeStreak } from '../compute-streak';

// Pure function — no Prisma, no clock mocking. `now` is injected and every engaged day is built by
// stepping whole calendar days off `now`, so the bucketing the implementation does (startOfDayInTZ +
// setDate walk) lines up regardless of the machine's own timezone.
const NOON_UTC = new Date('2026-06-15T12:00:00Z');

function daysAgo(now: Date, n: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

describe('computeStreak', () => {
  it('returns 1 for a first-ever engagement today', () => {
    expect(computeStreak([daysAgo(NOON_UTC, 0)], 'UTC', NOON_UTC)).toBe(1);
  });

  it('returns N for N consecutive engaged days ending today', () => {
    const days = [0, 1, 2, 3, 4].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(5);
  });

  it('preserves the prior run on a consecutive day (the previously-broken case)', () => {
    // The run ends YESTERDAY; today has no row yet (as when advance reads before writing).
    const days = [1, 2, 3].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(3);
  });

  it('still returns yesterday\'s run when today is not yet engaged', () => {
    const days = [1, 2].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(2);
  });

  it('collapses multiple same-day timestamps to one engaged day', () => {
    const days = [
      new Date('2026-06-15T08:00:00Z'),
      new Date('2026-06-15T15:00:00Z'),
      new Date('2026-06-15T23:00:00Z'),
      daysAgo(NOON_UTC, 1),
    ];
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(2);
  });

  it('counts only the most recent run when an older run is separated by a gap', () => {
    const days = [0, 1, 5, 6].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(2);
  });

  it('forgives a single missed day inside the run (grace), so the streak survives one gap', () => {
    // Engaged today, missed yesterday (day 1), a 3-day run before it (days 2-4) → today + 3 = 4,
    // the one gap bridged. This is what keeps /profile agreeing with the coaching grace message.
    const days = [0, 2, 3, 4].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(4);
  });

  it('forgives at most `graceDays` missed days — a second gap ends the run', () => {
    // Gaps at day 1 and day 3: bridge the first, stop at the second → today + day2 = 2.
    const days = [0, 2, 4].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(2);
  });

  it('honors graceDays = 0 (strict consecutive, no forgiveness)', () => {
    const days = [0, 2, 3].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC, 0)).toBe(1);
  });

  it('returns 0 after a long gap (no run ending today or yesterday)', () => {
    const days = [5, 6, 7].map((n) => daysAgo(NOON_UTC, n));
    expect(computeStreak(days, 'UTC', NOON_UTC)).toBe(0);
  });

  it('returns 0 for an empty log', () => {
    expect(computeStreak([], 'UTC', NOON_UTC)).toBe(0);
  });

  it('buckets day boundaries in the person\'s timezone', () => {
    // now = 2026-01-15T07:00Z → UTC day Jan 15, but in LA (UTC-8) it is Jan 14 23:00 → LA day Jan 14.
    const now = new Date('2026-01-15T07:00:00Z');
    const days = [
      new Date('2026-01-14T12:00:00Z'), // UTC: Jan 14 | LA: Jan 14 04:00
      new Date('2026-01-15T02:00:00Z'), // UTC: Jan 15 | LA: Jan 14 18:00
    ];

    // In UTC these are two distinct days (Jan 14 + 15) ending on today → streak 2.
    expect(computeStreak(days, 'UTC', now)).toBe(2);
    // In LA both collapse to Jan 14, which is "today" in LA → streak 1.
    expect(computeStreak(days, 'America/Los_Angeles', now)).toBe(1);
  });
});
