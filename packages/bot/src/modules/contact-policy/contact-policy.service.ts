import { Injectable } from '@nestjs/common';

export type ContactKind = 'checkin' | 'crisis-follow-up';

interface ContactProfile {
  respectsQuietHours: boolean;
  /** One-shot contacts defer to the next allowed window; recurring ones just skip this tick. */
  deferrable: boolean;
}

const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 8;

const PROFILES: Record<ContactKind, ContactProfile> = {
  // A routine Check-in is recurring (a cron re-fires), so a quiet-hours hit just skips this tick.
  checkin: { respectsQuietHours: true, deferrable: false },
  // A crisis-aftermath follow-up is one-shot and must not be lost — it defers to the next allowed
  // window. It is exempt from opt-in and the sparing rate (safety), but still respects quiet hours.
  'crisis-follow-up': { respectsQuietHours: true, deferrable: true },
};

export type ContactDecision =
  | { allow: true }
  | { allow: false; deferUntil: Date | null };

@Injectable()
export class ContactPolicyService {
  /**
   * The single gate for bot-initiated contact (ADR-0008): may Wabi DM this person now, for this kind
   * of contact? Owns quiet hours — the rule that is genuinely cross-cutting across every initiator.
   * A deferrable kind that hits quiet hours comes back with `deferUntil` (the next allowed window) so
   * the caller can reschedule; a non-deferrable kind comes back with `deferUntil: null` (skip).
   */
  mayContact(
    timezone: string,
    kind: ContactKind,
    now: Date = new Date(),
  ): ContactDecision {
    const profile = PROFILES[kind];
    if (profile.respectsQuietHours && this.inQuietHours(timezone, now)) {
      return {
        allow: false,
        deferUntil: profile.deferrable ? this.nextQuietHoursEnd(timezone, now) : null,
      };
    }
    return { allow: true };
  }

  inQuietHours(timezone: string, now: Date = new Date()): boolean {
    const hour = this.hourIn(timezone, now);
    if (hour == null) return true; // Safe default: assume quiet hours on an invalid timezone.
    return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  }

  private nextQuietHoursEnd(timezone: string, now: Date): Date {
    const hour = this.hourIn(timezone, now) ?? 0;
    const hoursUntilEnd =
      hour < QUIET_HOURS_END ? QUIET_HOURS_END - hour : 24 - hour + QUIET_HOURS_END;
    // Hour granularity is plenty for a gentle follow-up; align to the top of the allowed hour.
    const target = new Date(now.getTime() + hoursUntilEnd * 3600000);
    target.setMinutes(0, 0, 0);
    return target;
  }

  private hourIn(timezone: string, now: Date): number | null {
    try {
      const h = now.toLocaleString('en-US', {
        timeZone: timezone || 'UTC',
        hour: 'numeric',
        hour12: false,
      });
      const parsed = parseInt(h, 10);
      return Number.isNaN(parsed) ? null : parsed % 24;
    } catch {
      return null;
    }
  }
}
