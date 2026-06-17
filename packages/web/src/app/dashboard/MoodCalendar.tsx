'use client';

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
        className={`font-mono text-[10px] leading-none ${
          isToday ? 'text-copper' : 'text-bone-2'
        }`}
      >
        {day}
      </span>
      <span className="mt-0.5 text-lg leading-none">{emoji ?? ' '}</span>
    </div>
  );
}

export default function MoodCalendar({
  days,
  year,
  month,
  today,
}: {
  days: MoodDayPoint[];
  year: number;
  month: number;
  /** Today's local `YYYY-MM-DD`, used to highlight the current day. */
  today: string;
}) {
  const lead = firstWeekday(year, month);

  return (
    <div className="rounded-md border border-ink-2 bg-ink-0 p-4">
      <div className="mb-3 flex items-center justify-center">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-1">
          {MONTHS[month - 1]} {year}
        </span>
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

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {days.map((point) => (
          <DayCell key={point.date} point={point} isToday={point.date === today} />
        ))}
      </div>
    </div>
  );
}
