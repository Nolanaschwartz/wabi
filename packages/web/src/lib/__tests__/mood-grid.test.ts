import { buildMonthGrid } from '../mood-series';

const mood = (createdAt: string, rating: number) => ({
  createdAt: new Date(createdAt),
  rating,
});

const byDate = (grid: Array<{ date: string; avg: number | null }>) =>
  Object.fromEntries(grid.map((p) => [p.date, p.avg]));

describe('buildMonthGrid', () => {
  it('returns one entry per day of the month', () => {
    expect(buildMonthGrid([], 'UTC', 2026, 6)).toHaveLength(30); // June
    expect(buildMonthGrid([], 'UTC', 2026, 7)).toHaveLength(31); // July
  });

  it('handles February day count in leap and non-leap years', () => {
    expect(buildMonthGrid([], 'UTC', 2026, 2)).toHaveLength(28);
    expect(buildMonthGrid([], 'UTC', 2024, 2)).toHaveLength(29);
  });

  it('emits consecutive calendar days, oldest first', () => {
    const grid = buildMonthGrid([], 'UTC', 2026, 6);
    expect(grid[0].date).toBe('2026-06-01');
    expect(grid[grid.length - 1].date).toBe('2026-06-30');
    expect(grid.map((p) => p.date)).toEqual(
      Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('averages multiple entries on the same local day', () => {
    const grid = buildMonthGrid(
      [mood('2026-06-10T08:00:00Z', 2), mood('2026-06-10T20:00:00Z', 4)],
      'UTC',
      2026,
      6,
    );
    expect(byDate(grid)['2026-06-10']).toBe(3);
  });

  it('rounds the daily average to one decimal place', () => {
    const grid = buildMonthGrid(
      [
        mood('2026-06-15T08:00:00Z', 1),
        mood('2026-06-15T12:00:00Z', 1),
        mood('2026-06-15T16:00:00Z', 2),
      ],
      'UTC',
      2026,
      6,
    );
    // (1 + 1 + 2) / 3 = 1.333... -> 1.3
    expect(byDate(grid)['2026-06-15']).toBe(1.3);
  });

  it('represents days with no logs as null', () => {
    const grid = buildMonthGrid([mood('2026-06-10T08:00:00Z', 5)], 'UTC', 2026, 6);
    const map = byDate(grid);
    expect(map['2026-06-10']).toBe(5);
    expect(map['2026-06-09']).toBeNull();
    expect(map['2026-06-30']).toBeNull();
  });

  it('returns an all-null grid for empty input', () => {
    const grid = buildMonthGrid([], 'UTC', 2026, 6);
    expect(grid).toHaveLength(30);
    expect(grid.every((p) => p.avg === null)).toBe(true);
  });

  it('excludes entries from adjacent months', () => {
    const grid = buildMonthGrid(
      [
        mood('2026-05-31T12:00:00Z', 1),
        mood('2026-06-15T12:00:00Z', 4),
        mood('2026-07-01T12:00:00Z', 5),
      ],
      'UTC',
      2026,
      6,
    );
    const populated = grid.filter((p) => p.avg !== null);
    expect(populated).toEqual([{ date: '2026-06-15', avg: 4 }]);
  });

  it('buckets entries by the local calendar day of the given timezone', () => {
    // 2026-06-01T05:00:00Z is 2026-05-31 (22:00) in Los Angeles (PDT, UTC-7),
    // so it falls OUTSIDE June in LA but inside June in UTC.
    const entry = [mood('2026-06-01T05:00:00Z', 4)];

    expect(byDate(buildMonthGrid(entry, 'UTC', 2026, 6))['2026-06-01']).toBe(4);

    const la = buildMonthGrid(entry, 'America/Los_Angeles', 2026, 6);
    expect(la.every((p) => p.avg === null)).toBe(true);
  });

  it('treats an empty timezone as UTC', () => {
    const entry = [mood('2026-06-01T05:00:00Z', 4)];
    expect(byDate(buildMonthGrid(entry, '', 2026, 6))).toEqual(
      byDate(buildMonthGrid(entry, 'UTC', 2026, 6)),
    );
  });
});
