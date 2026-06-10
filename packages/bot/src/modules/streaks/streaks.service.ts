import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { startOfDayInTZ } from '../../lib/timezone-util';
import { XpService } from '../xp/xp.service';

const STREAK_GRACE_DAYS = 1;

export interface StreakTransition {
  streak: number;
  message: string;
  /** Whether this is the first Engagement of the day — the signal HabitEngagement uses to award XP
   * and log a row exactly once per engaged day (no inflation from repeat same-day activity). */
  isNewDay: boolean;
}

@Injectable()
export class StreaksService {
  constructor(private readonly xpService: XpService) {}

  // Streaks is a read model over the Engagement log (the xpEntry table). It never writes XP — that is
  // the one writer's job (HabitEngagementService, ADR-0027). `advance` computes the streak transition
  // from the log as it stands BEFORE the new Engagement is recorded.
  async advance(
    discordId: string,
    timezone: string = 'UTC',
  ): Promise<StreakTransition> {
    const today = startOfDayInTZ(timezone);
    const lastEntry = await prisma.xpEntry.findFirst({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastEntry) {
      return {
        streak: 1,
        message: "Welcome! Your streak has begun.",
        isNewDay: true,
      };
    }

    const lastDay = startOfDayInTZ(timezone, lastEntry.createdAt);
    const daysSince = Math.floor((today.getTime() - lastDay.getTime()) / 86400000);

    if (daysSince === 0) {
      // Already engaged today — the streak is unchanged and no new Engagement is logged.
      return {
        streak: await this.getCurrentStreak(discordId, timezone),
        message: '',
        isNewDay: false,
      };
    }

    if (daysSince === 1) {
      const streak = (await this.getCurrentStreak(discordId, timezone)) + 1;
      return {
        streak,
        message: streak >= 7 ? `🔥 ${streak}-day streak! You're on fire.` : "Great to see you again! Your streak continues.",
        isNewDay: true,
      };
    }

    if (daysSince <= STREAK_GRACE_DAYS + 1) {
      return {
        streak: await this.getCurrentStreak(discordId, timezone),
        message: "Welcome back! No worries about the break.",
        isNewDay: true,
      };
    }

    return {
      streak: 1,
      message: "Welcome back! Fresh start, no pressure.",
      isNewDay: true,
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

    // Wellness reads the Engagement log only — each habit-event counted once (ADR-0027), never Mood
    // or Tilt (ADR-0002). A journal write logs one Engagement row, so it is no longer added a second
    // time from the journalEntry table (the prior double-count).
    const engagements = await prisma.xpEntry.findMany({
      where: { userId: discordId, createdAt: { gte: since } },
    });

    const score = Math.min(100, Math.round((engagements.length / days) * 100));

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
      this.xpService.total(discordId),
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

}
