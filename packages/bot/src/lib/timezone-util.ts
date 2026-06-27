/** Hour-of-day (0–23) in the given timezone, or null if the timezone is invalid. */
export function currentHourInTZ(tz: string): number | null {
  try {
    const now = new Date();
    const hourStr = now.toLocaleString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(hourStr, 10);
  } catch {
    return null;
  }
}

/**
 * Calendar-day number (whole days since 1970-01-01) for instant `d` in timezone `tz`.
 *
 * Built from the Y-M-D parts in `tz` re-projected through Date.UTC, so the difference between two day
 * numbers is always an exact whole-day count — DST-safe. (Subtracting two server-local midnights is
 * NOT: across a transition adjacent local midnights are 23h/25h apart, so Math.floor(diff/86400000)
 * miscounts.) Falls back to the server-local calendar day when `tz` is invalid.
 */
export function dayNumberInTZ(tz: string, d: Date = new Date()): number {
  try {
    const [y, m, day] = d.toLocaleDateString('en-CA', { timeZone: tz }).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
  } catch {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }
}

/** The person's calendar day in `tz` as a "YYYY-MM-DD" key — the dedup unit for one Engagement/day. */
export function dayKeyInTZ(tz: string, d: Date = new Date()): string {
  try {
    return d.toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function startOfDayInTZ(tz: string, d: Date = new Date()): Date {
  try {
    const utcStr = d.toLocaleString('en-US', { timeZone: tz });
    const dt = new Date(utcStr);
    dt.setHours(0, 0, 0, 0);
    return dt;
  } catch {
    const fallback = new Date(d);
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  }
}
