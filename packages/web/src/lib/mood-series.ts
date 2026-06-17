/**
 * Pure mood-trend bucketing for the web dashboard chart.
 *
 * Buckets raw Mood rows into the user's *local* calendar day (per their IANA
 * timezone) and averages the 1-5 rating per day. Deterministic: `now` is passed
 * in, there is no I/O, and nothing here reads the clock or the DB — so it is
 * fully unit-testable. See `.scratch/mood-graph/PRD.md`.
 */

export interface MoodEntry {
  rating: number;
  createdAt: Date;
}

export interface MoodDayPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Mean rating for that day rounded to 1 decimal, or null if no logs. */
  avg: number | null;
}

/** Format a Date as the `YYYY-MM-DD` calendar day it falls on in `timeZone`. */
export function localDateString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Build a fixed-length daily-average mood series.
 *
 * @param moods    Rows to bucket (only `rating` and `createdAt` are read).
 * @param timezone IANA timezone for day boundaries; empty/unset is treated as UTC.
 * @param days     Number of day slots to emit.
 * @param now      Reference "today" — the series ends on this day's local date.
 * @returns        Exactly `days` slots, oldest first, `avg` null for empty days.
 */
export function buildMoodSeries(
  moods: ReadonlyArray<MoodEntry>,
  timezone: string,
  days: number,
  now: Date,
): MoodDayPoint[] {
  const tz = timezone || 'UTC';

  // Anchor on today's *local* calendar day, then step back whole days. We anchor
  // at midnight UTC of that Y-M-D so day-stepping is pure calendar arithmetic,
  // immune to DST shifts in the user's zone.
  const [y, m, d] = localDateString(now, tz).split('-').map(Number);
  const anchor = Date.UTC(y, m - 1, d);
  const DAY_MS = 86_400_000;

  // Sum ratings per local day.
  const sums = new Map<string, { total: number; count: number }>();
  for (const { rating, createdAt } of moods) {
    const key = localDateString(createdAt, tz);
    const slot = sums.get(key) ?? { total: 0, count: 0 };
    slot.total += rating;
    slot.count += 1;
    sums.set(key, slot);
  }

  const series: MoodDayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(anchor - i * DAY_MS);
    const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
    const slot = sums.get(date);
    const avg = slot ? Math.round((slot.total / slot.count) * 10) / 10 : null;
    series.push({ date, avg });
  }

  return series;
}

/**
 * Build a daily-average grid for one specific calendar month.
 *
 * Same local-day bucketing and rounding as {@link buildMoodSeries}, but anchored
 * to an arbitrary `year`/`month` rather than the last N days ending today — this
 * is what the dashboard's mood calendar paints, including months navigated to via
 * the API. Pure and deterministic: no clock, no I/O.
 *
 * @param moods    Rows to bucket (only `rating` and `createdAt` are read).
 * @param timezone IANA timezone for day boundaries; empty/unset is treated as UTC.
 * @param year     Four-digit calendar year of the target month.
 * @param month    Month number, 1 (January) – 12 (December).
 * @returns        One slot per day of that month, oldest first, `avg` null for empty days.
 */
export function buildMonthGrid(
  moods: ReadonlyArray<MoodEntry>,
  timezone: string,
  year: number,
  month: number,
): MoodDayPoint[] {
  const tz = timezone || 'UTC';

  // Day 0 of the *next* month is the last day of this month — gives 28/29/30/31.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Sum ratings per local day, exactly as buildMoodSeries does.
  const sums = new Map<string, { total: number; count: number }>();
  for (const { rating, createdAt } of moods) {
    const key = localDateString(createdAt, tz);
    const slot = sums.get(key) ?? { total: 0, count: 0 };
    slot.total += rating;
    slot.count += 1;
    sums.set(key, slot);
  }

  const grid: MoodDayPoint[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const slot = sums.get(date);
    const avg = slot ? Math.round((slot.total / slot.count) * 10) / 10 : null;
    grid.push({ date, avg });
  }

  return grid;
}
