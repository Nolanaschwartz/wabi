import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { startOfDayInTZ, dayNumberInTZ } from '../../lib/timezone-util';
import { computeStreak } from './compute-streak';

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
  // Streaks is a pure read model over the Engagement log (the xpEntry table). It never writes XP — that
  // is the one writer's job (HabitEngagementService, ADR-0027) — and never reads XP totals: the
  // cross-cutting wellness profile is assembled one layer up, in HabitEngagementService, so this model
  // stays free of any XP collaborator. `advance` computes the streak transition from the log as it
  // stands BEFORE the new Engagement is recorded.
  // One read of the Engagement log (ADR-0027), shared by advance and getCurrentStreak so both streak
  // surfaces read it identically. ponytail: unbounded by design — a streak can be arbitrarily long, so
  // we can't date-bound the read without risking truncating a real run; add a stored running-streak
  // counter if this read ever shows up hot.
  private async readEngagedDays(discordId: string): Promise<Date[]> {
    const entries = await prisma.xpEntry.findMany({
      where: { userId: discordId },
      select: { createdAt: true },
    });
    return entries.map((e) => e.createdAt);
  }

  async advance(
    discordId: string,
    timezone: string = 'UTC',
  ): Promise<StreakTransition> {
    const now = new Date();

    // The log as it stands BEFORE the new Engagement is recorded (ADR-0027).
    const engagedDays = await this.readEngagedDays(discordId);

    if (engagedDays.length === 0) {
      return {
        streak: 1,
        message: "Welcome! Your streak has begun.",
        isNewDay: true,
      };
    }

    // Day boundaries in the person's tz as day NUMBERS (DST-safe — subtracting server-local midnights
    // miscounts across a DST transition, where adjacent midnights are 23h/25h apart).
    const today = dayNumberInTZ(timezone, now);
    const lastDay = Math.max(...engagedDays.map((d) => dayNumberInTZ(timezone, d)));
    const daysSince = today - lastDay;

    // The current standing streak from the same grace-aware calculator that backs getCurrentStreak/
    // profile — so the two surfaces never disagree on the number. `now` anchors it: today is empty
    // here (advance runs before today's row exists), so this is the run ending at the most recent
    // engaged day, which today's engagement then extends.
    const run = computeStreak(engagedDays, timezone, now, STREAK_GRACE_DAYS);

    if (daysSince === 0) {
      // Already engaged today — the streak is unchanged and no new Engagement is logged.
      return {
        streak: run,
        message: '',
        isNewDay: false,
      };
    }

    if (daysSince === 1) {
      const streak = run + 1;
      return {
        streak,
        message: streak >= 7 ? `🔥 ${streak}-day streak! You're on fire.` : "Great to see you again! Your streak continues.",
        isNewDay: true,
      };
    }

    if (daysSince <= STREAK_GRACE_DAYS + 1) {
      // One missed day, forgiven: today's engagement continues (and extends) the prior run.
      return {
        streak: run + 1,
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
    // A single read of the Engagement log, then the same grace-aware math advance uses — so /profile
    // shows the number the coaching reply promised, grace and all (replaces the one-query-per-day loop).
    return computeStreak(await this.readEngagedDays(discordId), timezone, new Date(), STREAK_GRACE_DAYS);
  }

  async wellnessScore(
    discordId: string,
    timezone: string = 'UTC',
  ): Promise<{
    score: number;
    level: string;
  }> {
    const days = 30;
    // Anchor the trailing-30-day window on the start of the person's calendar day (in their tz), so the
    // Wellness window ticks over at their midnight — the same day boundary the streak read uses — rather
    // than drifting by the server's clock. tz has only a sub-day effect on a 30-day count, but threading
    // it keeps every Engagement read bucketing on one consistent boundary (ADR-0027).
    const since = startOfDayInTZ(timezone, new Date(Date.now() - days * 86400000));

    // Wellness reads the Engagement log only — each habit-event counted once (ADR-0027), never Mood
    // or Tilt (ADR-0002). A journal write logs one Engagement row, so it is no longer added a second
    // time from the journalEntry table (the prior double-count). Count in the database rather than
    // loading every row and taking `.length`, so the read does not scale with history length.
    const count = await prisma.xpEntry.count({
      where: { userId: discordId, createdAt: { gte: since } },
    });

    const score = Math.min(100, Math.round((count / days) * 100));

    const level = score >= 80 ? '🌟 Wellness Champion' :
                  score >= 60 ? '✨ Wellness Explorer' :
                  score >= 40 ? '🌱 Wellness Starter' :
                  '💪 Wellness Beginner';

    return { score, level };
  }
}
