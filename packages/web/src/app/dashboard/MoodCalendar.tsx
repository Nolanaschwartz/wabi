'use client';

import { useEffect, useState } from 'react';
import { ratingToEmoji } from '@wabi/shared';
import type { MoodDayPoint } from '@/lib/mood-series';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Weekday (0=Sun..6=Sat) of the first day of `year`/`month` (month is 1-12). */
function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

const key = (year: number, month: number) => `${year}-${month}`;

/** Days in `year`/`month` (month is 1-12). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Neutral, data-less grid for a month — keeps height stable while a month loads. */
function placeholderDays(year: number, month: number): MoodDayPoint[] {
  return Array.from({ length: daysInMonth(year, month) }, (_, i) => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    avg: null,
  }));
}

function DayCell({ point, isToday }: { point: MoodDayPoint; isToday: boolean }) {
  const day = Number(point.date.slice(-2));
  const emoji = point.avg === null ? null : ratingToEmoji(Math.round(point.avg));
  return (
    <div
      className={`flex aspect-square flex-col items-center justify-center rounded-md border text-center ${
        isToday ? 'border-copper bg-ink-0' : 'border-ink-2 bg-ink-0'
      }`}
    >
      <span
        className={`font-mono text-[10px] leading-none ${isToday ? 'text-copper' : 'text-bone-2'}`}
      >
        {day}
      </span>
      <span className="mt-0.5 text-lg leading-none">{emoji ?? ' '}</span>
    </div>
  );
}

export default function MoodCalendar({
  days,
  year,
  month,
  today,
}: {
  /** The current month's grid, seeded from the server (no fetch for the default view). */
  days: MoodDayPoint[];
  year: number;
  month: number;
  /** Today's local `YYYY-MM-DD`, used to highlight the current day and cap forward nav. */
  today: string;
}) {
  const [viewYear, setViewYear] = useState(year);
  const [viewMonth, setViewMonth] = useState(month);
  // Each fetched month is cached by `year-month` so revisiting never refetches.
  const [cache, setCache] = useState<Record<string, MoodDayPoint[]>>({
    [key(year, month)]: days,
  });
  const [loading, setLoading] = useState(false);

  const current = cache[key(viewYear, viewMonth)];

  // Fetch a navigated-to month the first time it is viewed.
  useEffect(() => {
    const k = key(viewYear, viewMonth);
    if (cache[k]) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/mood/calendar?year=${viewYear}&month=${viewMonth}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((body: { days: MoodDayPoint[] }) => {
        if (!cancelled) setCache((c) => ({ ...c, [k]: body.days }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewYear, viewMonth, cache]);

  const step = (delta: number) => {
    const m0 = viewMonth - 1 + delta; // to 0-based for modulo math
    setViewYear(viewYear + Math.floor(m0 / 12));
    setViewMonth(((m0 % 12) + 12) % 12 + 1);
  };

  const [todayYear, todayMonth] = today.split('-').map(Number);
  const atCurrentMonth = viewYear === todayYear && viewMonth === todayMonth;
  const lead = firstWeekday(viewYear, viewMonth);
  // Fall back to a same-size neutral grid for a not-yet-loaded month so the
  // calendar never collapses mid-navigation.
  const displayDays = current ?? placeholderDays(viewYear, viewMonth);

  return (
    <div className="rounded-md border border-ink-2 bg-ink-0 p-4">
      <div className="mb-3 flex items-center justify-between">
        <button
          onClick={() => step(-1)}
          aria-label="Previous month"
          className="rounded-md px-2 py-1 font-mono text-sm text-bone-2 transition-colors duration-200 ease-calm hover:text-bone-0"
        >
          ‹
        </button>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-1">
          {MONTHS[viewMonth - 1]} {viewYear}
        </span>
        <button
          onClick={() => step(1)}
          aria-label="Next month"
          disabled={atCurrentMonth}
          className="rounded-md px-2 py-1 font-mono text-sm text-bone-2 transition-colors duration-200 ease-calm hover:text-bone-0 disabled:opacity-30 disabled:hover:text-bone-2"
        >
          ›
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <span
            key={i}
            className="text-center font-mono text-[10px] uppercase tracking-[0.1em] text-bone-2"
          >
            {w}
          </span>
        ))}
      </div>

      <div className={`grid grid-cols-7 gap-1 ${loading ? 'opacity-40' : ''}`}>
        {Array.from({ length: lead }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {displayDays.map((point) => (
          <DayCell key={point.date} point={point} isToday={point.date === today} />
        ))}
      </div>
    </div>
  );
}
