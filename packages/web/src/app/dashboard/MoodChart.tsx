'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MoodDayPoint } from '@/lib/mood-series';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a `YYYY-MM-DD` slot for display without going through Date (no timezone surprises).
function formatDay(date: string): string {
  const [, mo, d] = date.split('-');
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}`;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.length || payload[0].value == null) return null;
  return (
    <div className="rounded-md border border-ink-3 bg-ink-2 px-3 py-2 shadow-lg">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2">
        {label ? formatDay(label) : ''}
      </p>
      <p className="mt-0.5 text-sm font-semibold text-bone-0">{payload[0].value} / 5</p>
    </div>
  );
}

export default function MoodChart({ data }: { data: MoodDayPoint[] }) {
  const hasData = data.some((p) => p.avg !== null);

  if (!hasData) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-ink-2 bg-ink-0">
        <p className="text-sm text-bone-2">No mood logged yet</p>
      </div>
    );
  }

  return (
    <div className="h-64 w-full rounded-md border border-ink-2 bg-ink-0 p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="var(--color-ink-3)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDay}
            minTickGap={24}
            tick={{ fill: 'var(--color-bone-2)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-ink-3)' }}
          />
          <YAxis
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fill: 'var(--color-bone-2)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-ink-3)' }}
            width={32}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-ink-4)' }} />
          <Line
            type="monotone"
            dataKey="avg"
            stroke="var(--color-copper)"
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 3, fill: 'var(--color-copper)', stroke: 'var(--color-copper)' }}
            activeDot={{ r: 5, fill: 'var(--color-copper-bright)', stroke: 'var(--color-copper-bright)' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
