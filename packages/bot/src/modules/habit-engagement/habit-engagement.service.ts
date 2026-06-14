import { Injectable } from '@nestjs/common';
import { XpService } from '../xp/xp.service';
import { StreaksService } from '../streaks/streaks.service';

export type Habit = 'coaching' | 'journal';

// The habit → XP table (ADR-0027). Which habits earn an Engagement, and for how much, is a single
// gentle-gamification decision made here — adding a habit (e.g. a Mood log) is a one-line change.
const HABIT_XP: Record<Habit, number> = {
  coaching: 10,
  journal: 10,
};

export interface EngagementResult {
  streak: number;
  message: string;
  xpAwarded: number;
}

@Injectable()
export class HabitEngagementService {
  constructor(
    private readonly xp: XpService,
    private readonly streaks: StreaksService,
  ) {}

  /**
   * The single writer for a habit-event (ADR-0027). One Engagement per engaged day: advance the
   * Streak from the prior log state, and on a new day log the Engagement by awarding its XP (the
   * xpEntry row IS the Engagement). Repeat same-day activity neither re-awards nor inflates the log,
   * so Streak, XP, and Wellness Score all derive consistently from one unit.
   */
  async record(
    userId: string,
    habit: Habit,
    timezone = 'UTC',
  ): Promise<EngagementResult> {
    const transition = await this.streaks.advance(userId, timezone);
    if (!transition.isNewDay) {
      return { streak: transition.streak, message: transition.message, xpAwarded: 0 };
    }

    const xpAwarded = HABIT_XP[habit];
    await this.xp.award(userId, xpAwarded, habit);
    return { streak: transition.streak, message: transition.message, xpAwarded };
  }

  /**
   * The Engagement read model (ADR-0027): the single cross-cutting view of a person's gamification —
   * total XP, current Streak, Wellness Score + level. It lives here, the one place that already holds
   * both collaborators, so neither leaf model has to reach into the other (Streaks no longer depends on
   * XP). Each field reads the Engagement log independently, so they fetch concurrently.
   */
  async profile(userId: string): Promise<{
    xp: number;
    streak: number;
    wellnessScore: number;
    wellnessLevel: string;
  }> {
    const [xp, streak, wellness] = await Promise.all([
      this.xp.total(userId),
      this.streaks.getCurrentStreak(userId),
      this.streaks.wellnessScore(userId),
    ]);

    return { xp, streak, wellnessScore: wellness.score, wellnessLevel: wellness.level };
  }
}
