import { redirect } from 'next/navigation';
import { validateRequest } from '@/lib/session';
import { prisma } from '@wabi/shared';
import DashboardView from './dashboard-view';

export default async function DashboardPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect('/api/auth/discord');
  }

  const [moods, playtimes, streak] = await Promise.all([
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
  ]);

  return (
    <DashboardView
      user={user}
      moods={moods}
      playtimes={playtimes}
      streak={streak}
    />
  );
}
