import { dayNumberInTZ } from '../../lib/timezone-util';

/**
 * Pure, DB-free streak calculator (ADR-0027 — Streaks is a read model over the Engagement log).
 *
 * Counts the unbroken run of engaged days ending at the person's most recent engaged day, forgiving up
 * to `graceDays` missed days inside the run. The grace is bridged HERE (not persisted as a fake
 * Engagement, which would inflate XP/Wellness), so `getCurrentStreak`/`/profile` show the SAME number
 * the coaching reply's grace message promises — the two surfaces never disagree.
 *
 * Anchor rule: walk backward from TODAY if it is engaged, otherwise from YESTERDAY. An un-engaged
 * "today" is "not yet", not a missed day, so it spends no grace. This lets a streak that ended
 * yesterday survive before today's Engagement row exists — the headline bug was anchoring strictly on
 * today, so the first window was empty and the walk terminated at 0.
 *
 * Day boundaries are computed in `timezone` via day NUMBERS (DST-safe), so multiple timestamps on the
 * same calendar day collapse to one engaged day and the backward walk never drifts across a transition.
 *
 * @param engagedDays the person's Engagement timestamps (unbucketed, any order)
 * @param timezone    the person's IANA timezone
 * @param now         injectable "current time" so every scenario is testable without mocking the clock
 * @param graceDays   missed days forgiven within the run (default 1, matching STREAK_GRACE_DAYS)
 * @returns the current streak length (0 when no run reaches today or yesterday)
 */
export function computeStreak(
  engagedDays: Date[],
  timezone: string,
  now: Date = new Date(),
  graceDays: number = 1,
): number {
  const dayNums = new Set<number>(engagedDays.map((d) => dayNumberInTZ(timezone, d)));
  const today = dayNumberInTZ(timezone, now);

  // Anchor on today if engaged, else step to yesterday (today-not-yet is free, costs no grace).
  let cursor = dayNums.has(today) ? today : today - 1;
  let budget = graceDays;
  let streak = 0;

  while (true) {
    if (dayNums.has(cursor)) {
      streak++;
      cursor--;
    } else if (budget > 0 && dayNums.has(cursor - 1)) {
      // One missed day, forgiven — bridge to the engaged day before it (the gap day is not counted).
      budget--;
      cursor--;
    } else {
      break;
    }
  }

  return streak;
}
