import { prisma } from '@wabi/shared';

const STREAK_GRACE_DAYS = 1;

export class StreaksService {
  async checkAndAward(discordId: string): Promise<{
    streak: number;
    message: string;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const lastEntry = await prisma.xpEntry.findFirst({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastEntry) {
      return {
        streak: 1,
        message: "Welcome! Your streak has begun.",
      };
    }

    const lastDay = new Date(lastEntry.createdAt);
    lastDay.setHours(0, 0, 0, 0);

    const daysSince = Math.floor((today.getTime() - lastDay.getTime()) / 86400000);

    if (daysSince === 1) {
      return {
        streak: (await this.getCurrentStreak(discordId)) + 1,
        message: "Great to see you again! Your streak continues.",
      };
    }

    if (daysSince <= STREAK_GRACE_DAYS) {
      return {
        streak: await this.getCurrentStreak(discordId),
        message: "Welcome back! No worries about the break.",
      };
    }

    return {
      streak: 1,
      message: "Welcome back! Fresh start, no pressure.",
    };
  }

  async getCurrentStreak(discordId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let streak = 0;
    let checkDate = new Date(today);

    while (true) {
      const entries = await prisma.xpEntry.findMany({
        where: {
          userId: discordId,
          createdAt: {
            gte: checkDate,
          },
        },
        take: 1,
      });

      if (entries.length === 0) {
        break;
      }

      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    return streak;
  }

  async wellnessScore(discordId: string): Promise<{
    score: number;
    level: string;
  }> {
    const days = 30;
    const since = new Date(Date.now() - days * 86400000);

    const [xpEntries, journals] = await Promise.all([
      prisma.xpEntry.findMany({
        where: { userId: discordId, createdAt: { gte: since } },
      }),
      prisma.journalEntry.findMany({
        where: { userId: discordId, createdAt: { gte: since } },
      }),
    ]);

    const activities = xpEntries.length + journals.length;
    const score = Math.min(100, Math.round((activities / days) * 100));

    const level = score >= 80 ? '🌟 Wellness Champion' :
                  score >= 60 ? '✨ Wellness Explorer' :
                  score >= 40 ? '🌱 Wellness Starter' :
                  '💪 Wellness Beginner';

    return { score, level };
  }

  async profile(discordId: string): Promise<{
    xp: number;
    streak: number;
    wellnessScore: number;
    wellnessLevel: string;
  }> {
    const [totalXp, streakData, wellness] = await Promise.all([
      this.getTotalXp(discordId),
      this.getCurrentStreak(discordId),
      this.wellnessScore(discordId),
    ]);

    return {
      xp: totalXp,
      streak: streakData,
      wellnessScore: wellness.score,
      wellnessLevel: wellness.level,
    };
  }

  private async getTotalXp(discordId: string): Promise<number> {
    const entries = await prisma.xpEntry.findMany({
      where: { userId: discordId },
    });

    return entries.reduce((acc, e) => acc + e.amount, 0);
  }
}
