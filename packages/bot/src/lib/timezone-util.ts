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

export function dateInTZ(tz: string, d: Date = new Date()): string {
  try {
    return d.toLocaleString('en-US', { timeZone: tz });
  } catch {
    return d.toLocaleString();
  }
}
