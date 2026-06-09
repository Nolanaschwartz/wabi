import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { XpService } from '../xp/xp.service';

const STREAK_GRACE_DAYS = 1;
const XP_PER_COACHING_TURN = 10;

function startOfDayInTZ(tz: string, d: Date = new Date()): Date {
  try {
    const utcStr = d.toLocaleString('en-US', { timeZone: tz });
    const dt = new Date(utcStr);
    dt.setHours(0, 0, 0, 0);
    return dt;
  } catch {
    const fallback = new Date(d);
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  }
}

@Injectable()
export class StreaksService {
  // XP is awarded through XpService — the sole writer of the xpEntry ledger. Streaks still READS
  // xpEntry to infer daily engagement (see the double-duty note below), but never writes it raw.
  constructor(private readonly xp: XpService) {}

  async checkAndAward(
    discordId: string,
    timezone: string = 'UTC',
  ): Promise<{
    streak: number;
    message: string;
  }> {
    const today = startOfDayInTZ(timezone);
    const lastEntry = await prisma.xpEntry.findFirst({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastEntry) {
      await this.xp.award(discordId, XP_PER_COACHING_TURN, 'coaching');
      return {
        streak: 1,
        message: "Welcome! Your streak has begun.",
      };
    }

    const lastDay = startOfDayInTZ(timezone, lastEntry.createdAt);
    const daysSince = Math.floor((today.getTime() - lastDay.getTime()) / 86400000);

    if (daysSince === 0) {
      return {
        streak: await this.getCurrentStreak(discordId, timezone),
        message: '',
      };
    }

    if (daysSince === 1) {
      await this.xp.award(discordId, XP_PER_COACHING_TURN, 'coaching');
      const streak = (await this.getCurrentStreak(discordId, timezone)) + 1;
      return {
        streak,
        message: streak >= 7 ? `🔥 ${streak}-day streak! You're on fire.` : "Great to see you again! Your streak continues.",
      };
    }

    if (daysSince <= STREAK_GRACE_DAYS + 1) {
      await this.xp.award(discordId, XP_PER_COACHING_TURN, 'coaching');
      return {
        streak: await this.getCurrentStreak(discordId, timezone),
        message: "Welcome back! No worries about the break.",
      };
    }

    await this.xp.award(discordId, XP_PER_COACHING_TURN, 'coaching');
    return {
      streak: 1,
      message: "Welcome back! Fresh start, no pressure.",
    };
  }

  async getCurrentStreak(discordId: string, timezone: string = 'UTC'): Promise<number> {
    const today = startOfDayInTZ(timezone);

    let streak = 0;
    let checkDate = new Date(today);

    while (true) {
      const nextDay = new Date(checkDate);
      nextDay.setDate(nextDay.getDate() + 1);

      const entries = await prisma.xpEntry.findMany({
        where: {
          userId: discordId,
          createdAt: {
            gte: checkDate,
            lt: nextDay,
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
