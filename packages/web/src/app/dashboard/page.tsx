import { redirect } from 'next/navigation';
import { validateRequest } from '@/lib/session';
import { prisma, decideAccess } from '@wabi/shared';
import { localDateString } from '@/lib/mood-series';
import { dashboardMood, type MoodReader } from '@/lib/mood-read';
import DashboardView from './dashboard-view';

export default async function DashboardPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect('/api/auth/discord');
  }

  const now = new Date();
  const timezone = user.timezone ?? 'UTC';
  const acct = { discordId: user.discordId, timezone };

  // The calendar's default month is today's local month.
  const today = localDateString(now, timezone);
  const [calendarYear, calendarMonth] = today.split('-').map(Number);

  // Reads only — always available regardless of access tier (ADR-0011). The mood series +
  // current-month grid come from ONE windowed fetch via the mood-read module (padded window,
  // timezone, and Mood key decided there); the recent-list, playtime, and xp reads stay local.
  const [moods, playtimes, streak, mood] = await Promise.all([
    prisma.mood.findMany({
      where: { userId: user.discordId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.playtimeLog.findMany({
      where: { userId: user.discordId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.xpEntry.count({
      where: { userId: user.discordId },
    }),
    dashboardMood(prisma as unknown as MoodReader, acct, now),
  ]);
  const { series: moodSeries, monthGrid: moodGrid } = mood;

  // Derive billing display from the SAME shared decision the bot gates on (decideAccess), so the
  // dashboard and the coaching gate can never disagree — e.g. a lapsed trial reads "Not subscribed"
  // here exactly when the bot stops coaching.
  const access = decideAccess(user, new Date());
  const billing = {
    hasActiveAccess: access.hasActiveAccess,
    subscriptionStatus: access.subscriptionStatus,
    trialEndsAt: user.trialEndsAt ? user.trialEndsAt.toISOString() : null,
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
