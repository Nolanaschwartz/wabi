import { redirect } from 'next/navigation';
import { validateRequest } from '@/lib/session';
import { prisma, decideAccess } from '@wabi/shared';
import { buildMoodSeries, buildMonthGrid, localDateString } from '@/lib/mood-series';
import DashboardView from './dashboard-view';

// The chart shows the last 30 *local* days; we fetch 31 so timezone bucketing at
// the window edge can never drop a valid day.
const CHART_WINDOW_DAYS = 30;
const FETCH_WINDOW_DAYS = CHART_WINDOW_DAYS + 1;
const DAY_MS = 86_400_000;

export default async function DashboardPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect('/api/auth/discord');
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - FETCH_WINDOW_DAYS * DAY_MS);

  const [moods, moodWindow, playtimes, streak, dbUser] = await Promise.all([
    prisma.mood.findMany({
      where: { userId: user.discordId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.mood.findMany({
      where: { userId: user.discordId, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
      select: { rating: true, createdAt: true },
    }),
    prisma.playtimeLog.findMany({
      where: { userId: user.discordId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.xpEntry.count({
      where: { userId: user.discordId },
    }),
    prisma.user.findUnique({ where: { id: user.id } }),
  ]);

  const timezone = dbUser?.timezone ?? 'UTC';

  // Daily-average mood over the last 30 local days, bucketed in the user's timezone.
  const moodSeries = buildMoodSeries(moodWindow, timezone, CHART_WINDOW_DAYS, now);

  // Seed the calendar's current month from the same 31-day window (it fully covers
  // this month up to today), so the default view paints with no extra query.
  const today = localDateString(now, timezone);
  const [calendarYear, calendarMonth] = today.split('-').map(Number);
  const moodGrid = buildMonthGrid(moodWindow, timezone, calendarYear, calendarMonth);

  // Derive billing display from the SAME shared decision the bot gates on (decideAccess), so the
  // dashboard and the coaching gate can never disagree — e.g. a lapsed trial reads "Not subscribed"
  // here exactly when the bot stops coaching.
  const access = decideAccess(dbUser, new Date());
  const billing = {
    hasActiveAccess: access.hasActiveAccess,
    subscriptionStatus: access.subscriptionStatus,
    trialEndsAt: dbUser?.trialEndsAt ? dbUser.trialEndsAt.toISOString() : null,
  };

  return (
    <DashboardView
      user={user}
      moods={moods}
      moodSeries={moodSeries}
      moodGrid={moodGrid}
      calendarYear={calendarYear}
      calendarMonth={calendarMonth}
      today={today}
      playtimes={playtimes}
      streak={streak}
      billing={billing}
    />
  );
}
