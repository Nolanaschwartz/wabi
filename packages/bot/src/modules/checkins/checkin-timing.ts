import { prisma } from '@wabi/shared';
import { ContactPolicyService } from '../contact-policy/contact-policy.service';

const LATE_NIGHT_HOUR = 23;

// Quiet hours are owned by the one Contact Policy (ADR-0008) so check-ins and the crisis-aftermath
// follow-up share a single implementation. CheckInTiming delegates to it (the service is stateless,
// reads no env, so a module-level instance is safe).
const contactPolicy = new ContactPolicyService();

export const CHECK_IN_CADENCES = ['daily', 'every-other', 'weekly'] as const;
export type CheckInCadence = (typeof CHECK_IN_CADENCES)[number];

export class CheckInTiming {
  static isWithinQuietHours(userTimezone: string): boolean {
    return contactPolicy.inQuietHours(userTimezone);
  }

  static isLateNightForUser(userTimezone: string): boolean {
    try {
      const now = new Date();
      const userHour = now.toLocaleString('en-US', {
        timeZone: userTimezone || 'UTC',
        hour: 'numeric',
        hour12: false,
      });

      return parseInt(userHour, 10) >= LATE_NIGHT_HOUR;
    } catch {
      return true; // Safe default: assume late night on invalid timezone
    }
  }

  static isCheckInDue(user: {
    lastCheckIn: Date | null;
    cadence: CheckInCadence;
    timezone: string;
  }): boolean {
    if (this.isWithinQuietHours(user.timezone)) return false;
    if (this.isLateNightForUser(user.timezone)) return false;

    if (!user.lastCheckIn) return true;

    const now = new Date();
    const lastCheckIn = new Date(user.lastCheckIn);
    const daysSince = (now.getTime() - lastCheckIn.getTime()) / 86400000;

    switch (user.cadence) {
      case 'daily':
        return daysSince >= 1;
      case 'every-other':
        return daysSince >= 2;
      case 'weekly':
        return daysSince >= 7;
      default:
        return false;
    }
  }
}

export class CheckInScheduler {
  async findDueUsers(): Promise<{ discordId: string; timezone: string }[]> {
    const users = await prisma.user.findMany({
      where: {
        checkInsEnabled: true,
      },
      select: {
        discordId: true,
        timezone: true,
        lastCheckIn: true,
        checkInCadence: true,
      },
    });

    return users.filter((user) =>
      CheckInTiming.isCheckInDue({
        lastCheckIn: user.lastCheckIn,
        cadence: user.checkInCadence as CheckInCadence,
        timezone: user.timezone || 'UTC',
      }),
    );
  }

  async recordCheckIn(discordId: string): Promise<void> {
    await prisma.user.update({
      where: { discordId },
      data: { lastCheckIn: new Date() },
    });
  }
}
