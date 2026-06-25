import { dashboardMood, monthGrid, type MoodReader, type MoodRow } from '../mood-read';

const DAY_MS = 86_400_000;

/**
 * In-memory MoodReader double. Captures the last `where` it was called with and
 * returns the configured rows (optionally filtered by the createdAt window so the
 * window-edge assertions exercise the real boundary the module computes).
 */
function reader(rows: MoodRow[], opts: { filter?: boolean } = {}) {
  const calls: any[] = [];
  const db: MoodReader = {
    mood: {
      findMany: async (args) => {
        calls.push(args);
        if (!opts.filter) return rows;
        const { gte, lt } = args.where.createdAt ?? {};
        return rows.filter(
          (r) =>
            (gte === undefined || r.createdAt >= gte) &&
            (lt === undefined || r.createdAt < lt),
        );
      },
    },
  };
  return { db, calls };
}

describe('mood-read module', () => {
  describe('monthGrid', () => {
    it('returns one slot per day of the requested month', async () => {
      const { db } = reader([]);
      const days = await monthGrid(db, { discordId: 'd', timezone: 'UTC' }, 2026, 5);
      expect(days).toHaveLength(31); // May
    });

    it('returns an all-null month when there are no logs', async () => {
      const { db } = reader([]);
      const days = await monthGrid(db, { discordId: 'd', timezone: 'UTC' }, 2026, 2);
      expect(days).toHaveLength(28);
      expect(days.every((d) => d.avg === null)).toBe(true);
    });

    it('buckets entries in the account timezone (LA boundary case)', async () => {
      // 2026-05-01T05:00:00Z is 2026-04-30 22:00 in LA — outside May there.
      const { db } = reader([{ rating: 5, createdAt: new Date('2026-05-01T05:00:00Z') }]);
      const days = await monthGrid(
        db,
        { discordId: 'd', timezone: 'America/Los_Angeles' },
        2026,
        5,
      );
      expect(days.every((d) => d.avg === null)).toBe(true);
    });

    it('averages multiple logs on the same local day', async () => {
      const { db } = reader([
        { rating: 2, createdAt: new Date('2026-05-10T08:00:00Z') },
        { rating: 4, createdAt: new Date('2026-05-10T20:00:00Z') },
      ]);
      const days = await monthGrid(db, { discordId: 'd', timezone: 'UTC' }, 2026, 5);
      const map = Object.fromEntries(days.map((d) => [d.date, d.avg]));
      expect(map['2026-05-10']).toBe(3);
      expect(map['2026-05-11']).toBeNull();
    });

    it('queries moods by the caller own discordId with a padded month window', async () => {
      const { db, calls } = reader([]);
      await monthGrid(db, { discordId: 'disc_me', timezone: 'UTC' }, 2026, 5);
      expect(calls[0].where.userId).toBe('disc_me');
      // padded one day each edge: gte < first-of-month, lt > first-of-next-month
      expect(calls[0].where.createdAt.gte.getTime()).toBe(Date.UTC(2026, 4, 1) - DAY_MS);
      expect(calls[0].where.createdAt.lt.getTime()).toBe(Date.UTC(2026, 5, 1) + DAY_MS);
    });
  });

  describe('dashboardMood', () => {
    const now = new Date('2026-06-15T12:00:00Z');

    it('derives the series AND current-month grid from a SINGLE query by the caller discordId', async () => {
      const { db, calls } = reader([]);
      const { series, monthGrid: grid } = await dashboardMood(
        db,
        { discordId: 'disc_me', timezone: 'UTC' },
        now,
      );
      expect(calls).toHaveLength(1); // the regression guard: one fetch, not two
      expect(calls[0].where.userId).toBe('disc_me');
      expect(calls[0].where.createdAt.gte.getTime()).toBe(now.getTime() - 31 * DAY_MS);
      expect(series).toHaveLength(30);
      expect(grid).toHaveLength(30); // June
    });

    it('includes a row inside the 31-day window and drops one outside it', async () => {
      const inside = { rating: 5, createdAt: new Date(now.getTime() - 2 * DAY_MS) };
      const outside = { rating: 1, createdAt: new Date(now.getTime() - 40 * DAY_MS) };
      const { db } = reader([inside, outside], { filter: true });
      const { series } = await dashboardMood(db, { discordId: 'd', timezone: 'UTC' }, now);
      const nonNull = series.filter((s) => s.avg !== null);
      expect(nonNull).toHaveLength(1);
      expect(nonNull[0].avg).toBe(5);
    });

    it('paints the current local month grid from the window rows', async () => {
      const row = { rating: 4, createdAt: new Date('2026-06-10T12:00:00Z') };
      const { db } = reader([row], { filter: true });
      const { monthGrid: grid } = await dashboardMood(
        db,
        { discordId: 'd', timezone: 'UTC' },
        now,
      );
      const map = Object.fromEntries(grid.map((d) => [d.date, d.avg]));
      expect(map['2026-06-10']).toBe(4);
    });
  });
});
