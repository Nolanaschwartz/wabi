import { buildMoodSeries } from '../mood-series';

// A fixed reference "now" so the window is deterministic.
// 2026-06-17T12:00:00Z is noon UTC and morning (05:00) in America/Los_Angeles,
// so the *local calendar day* is 2026-06-17 in both UTC and LA — the windows align.
const NOW = new Date('2026-06-17T12:00:00Z');

const mood = (createdAt: string, rating: number) => ({
  createdAt: new Date(createdAt),
  rating,
});

// Convenience: index the series by its date string.
const byDate = (series: Array<{ date: string; avg: number | null }>) =>
  Object.fromEntries(series.map((p) => [p.date, p.avg]));

describe('buildMoodSeries', () => {
  it('returns exactly `days` slots', () => {
    expect(buildMoodSeries([], 'UTC', 7, NOW)).toHaveLength(7);
    expect(buildMoodSeries([], 'UTC', 30, NOW)).toHaveLength(30);
  });

  it('emits consecutive calendar days, oldest first, ending on today in the timezone', () => {
    const series = buildMoodSeries([], 'UTC', 7, NOW);
    expect(series.map((p) => p.date)).toEqual([
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
    ]);
  });

  it('averages multiple entries on the same local day', () => {
    const series = buildMoodSeries(
      [mood('2026-06-17T08:00:00Z', 2), mood('2026-06-17T20:00:00Z', 4)],
      'UTC',
      7,
      NOW,
    );
    expect(byDate(series)['2026-06-17']).toBe(3);
  });

  it('rounds the daily average to one decimal place', () => {
    const series = buildMoodSeries(
      [
        mood('2026-06-15T08:00:00Z', 1),
        mood('2026-06-15T12:00:00Z', 1),
        mood('2026-06-15T16:00:00Z', 2),
      ],
      'UTC',
      7,
      NOW,
    );
    // (1 + 1 + 2) / 3 = 1.333... -> 1.3
    expect(byDate(series)['2026-06-15']).toBe(1.3);
  });

  it('represents days with no logs as null', () => {
    const series = buildMoodSeries([mood('2026-06-17T08:00:00Z', 5)], 'UTC', 7, NOW);
    const map = byDate(series);
    expect(map['2026-06-17']).toBe(5);
    expect(map['2026-06-16']).toBeNull();
    expect(map['2026-06-11']).toBeNull();
  });

  it('returns an all-null series of the right length for empty input', () => {
    const series = buildMoodSeries([], 'UTC', 7, NOW);
    expect(series).toHaveLength(7);
    expect(series.every((p) => p.avg === null)).toBe(true);
  });

  it('places a single entry in exactly one slot', () => {
    const series = buildMoodSeries([mood('2026-06-14T10:00:00Z', 3)], 'UTC', 7, NOW);
    const populated = series.filter((p) => p.avg !== null);
    expect(populated).toEqual([{ date: '2026-06-14', avg: 3 }]);
  });

  it('buckets entries by the local calendar day of the given timezone', () => {
    // 2026-06-17T05:00:00Z is still 2026-06-16 (22:00) in Los Angeles (PDT, UTC-7).
    const entry = [mood('2026-06-17T05:00:00Z', 4)];

    const utc = byDate(buildMoodSeries(entry, 'UTC', 7, NOW));
    expect(utc['2026-06-17']).toBe(4);
    expect(utc['2026-06-16']).toBeNull();

    const la = byDate(buildMoodSeries(entry, 'America/Los_Angeles', 7, NOW));
    expect(la['2026-06-16']).toBe(4);
    expect(la['2026-06-17']).toBeNull();
  });

  it('treats an empty timezone as UTC', () => {
    const entry = [mood('2026-06-17T05:00:00Z', 4)];
    expect(byDate(buildMoodSeries(entry, '', 7, NOW))).toEqual(
      byDate(buildMoodSeries(entry, 'UTC', 7, NOW)),
    );
  });
});
