import { redirect } from 'next/navigation';
import { validateRequest } from '@/lib/session';
import { prisma, decideAccess } from '@wabi/shared';
import DashboardView from './dashboard-view';

export default async function DashboardPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect('/api/auth/discord');
  }

  const [moods, playtimes, streak, dbUser] = await Promise.all([
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
    prisma.user.findUnique({ where: { id: user.id } }),
  ]);

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
      playtimes={playtimes}
      streak={streak}
      billing={billing}
    />
  );
}
