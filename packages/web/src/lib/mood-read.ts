/**
 * Mood-read module — the I/O orchestration around the pure mood bucketer.
 *
 * `mood-series.ts` (buildMoodSeries / buildMonthGrid) is the deep, pure core and is
 * tested independently. This module owns the *reads* that feed it — the padded fetch
 * window, the timezone, and the Mood query key — so those are decided once instead of
 * duplicated across the dashboard page and the calendar route. Read-only and never
 * access-tier gated (ADR-0011): a person can always see their own data.
 *
 * The store is reached through a narrow injected `MoodReader` seam: prod passes the
 * real `prisma`; tests pass an in-memory double, so the read path (window/timezone/key)
 * is tested at this interface rather than through a route + `jest.mock('@wabi/shared')`.
 */
import {
  buildMoodSeries,
  buildMonthGrid,
  localDateString,
  type MoodDayPoint,
} from './mood-series';

export interface MoodRow {
  rating: number;
  createdAt: Date;
}

/** Only the slice of the Prisma client this module needs — the seam tests substitute. */
export interface MoodReader {
  mood: {
    findMany(args: {
      where: { userId: string; createdAt?: { gte?: Date; lt?: Date } };
      select: { rating: true; createdAt: true };
      orderBy?: { createdAt: 'asc' };
    }): Promise<MoodRow[]>;
  };
}

/**
 * A person, as far as a Mood read cares: their Discord ID (the Mood rows' `userId`
 * key — NOT the web `User.id`) and the IANA timezone day boundaries are computed in.
 */
export interface Account {
  discordId: string;
  timezone: string;
}

// The chart shows the last 30 *local* days; fetch 31 so timezone bucketing at the
// window edge can never drop a valid day.
const CHART_WINDOW_DAYS = 30;
const FETCH_WINDOW_DAYS = CHART_WINDOW_DAYS + 1;
const DAY_MS = 86_400_000;

/**
 * The dashboard's two mood reads from ONE fetch. The default calendar month is the current
 * local month, which the 31-day series window already fully covers (the month so far is ≤31
 * days), so we bucket both the series and the current-month grid from a single query instead
 * of a second padded-month round-trip on the hot dashboard path. Other months go through
 * {@link monthGrid} (the calendar route, its own padded fetch).
 *
 * ponytail: reuses the series window for the current month — a far-timezone log on the very
 * first local day of the month could sit just outside the window and miss this grid; monthGrid's
 * dedicated pad catches it. Accepted (the prior dashboard made the same trade) — the calendar
 * route paints the exact grid on navigation.
 */
export async function dashboardMood(
  db: MoodReader,
  acct: Account,
  now: Date,
): Promise<{ series: MoodDayPoint[]; monthGrid: MoodDayPoint[] }> {
  const windowStart = new Date(now.getTime() - FETCH_WINDOW_DAYS * DAY_MS);
  const rows = await db.mood.findMany({
    where: { userId: acct.discordId, createdAt: { gte: windowStart } },
    select: { rating: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const [year, month] = localDateString(now, acct.timezone || 'UTC')
    .split('-')
    .map(Number);
  return {
    series: buildMoodSeries(rows, acct.timezone, CHART_WINDOW_DAYS, now),
    monthGrid: buildMonthGrid(rows, acct.timezone, year, month),
  };
}

/** Daily-average grid for one calendar month, padded one day each edge before fetching. */
export async function monthGrid(
  db: MoodReader,
  acct: Account,
  year: number,
  month: number,
): Promise<MoodDayPoint[]> {
  // Pad one day on each side so timezone bucketing at the month boundary can never
  // drop a valid local day; buildMonthGrid does the exact local-day attribution.
  const gte = new Date(Date.UTC(year, month - 1, 1) - DAY_MS);
  const lt = new Date(Date.UTC(year, month, 1) + DAY_MS);
  const rows = await db.mood.findMany({
    where: { userId: acct.discordId, createdAt: { gte, lt } },
    select: { rating: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return buildMonthGrid(rows, acct.timezone, year, month);
}
