import { Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { CheckInScheduler } from './checkin-timing';
import { CoachingService } from '../coaching/coaching.service';
import { JobRegistry } from '../scheduler/job-registry';
import { Job } from '../scheduler/jobs';

const CHECK_IN_CRON = '0 */4 * * *';
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

@Injectable()
export class CheckInService {
  constructor(
    private readonly scheduler: CheckInScheduler,
    private readonly coachingService: CoachingService,
    private readonly client: Client,
    private readonly jobs: JobRegistry,
  ) {}

  init(): void {
    // Declare the check-in cron; the Scheduler binds it at bootstrap, lifecycle is the Scheduler's.
    this.jobs.declare({
      name: Job.CheckIn,
      kind: 'cron',
      cron: CHECK_IN_CRON,
      owner: 'checkins',
      handler: this.handleCheckIns.bind(this),
    });
  }

  private async handleCheckIns(): Promise<void> {
    const dueUsers = await this.scheduler.findDueUsers();

    // Fan the DMs out concurrently — each user is independent, so the cron no longer waits for one
    // user's send+record before starting the next. discord.js serializes under its own per-route rate
    // limiter, and the per-user try/catch keeps one blocked-DM failure from sinking the batch.
    // ponytail: unbounded fan-out is fine at current scale; add a concurrency cap if dueUsers gets large.
    await Promise.all(
      dueUsers.map(async (user) => {
        try {
          await this.client.users.send(user.discordId, {
            content: 'Hey there! How are you doing today?',
          });

          await this.scheduler.recordCheckIn(user.discordId);
        } catch {
          // User may have blocked DMs
        }
      }),
    );
  }

  async toggleCheckIn(discordId: string, enabled: boolean): Promise<void> {
    await prisma.user.update({
      where: { discordId },
      data: { checkInsEnabled: enabled },
    });
  }

  async setCadence(
    discordId: string,
    cadence: 'daily' | 'every-other' | 'weekly',
  ): Promise<void> {
    await prisma.user.update({
      where: { discordId },
      data: { checkInCadence: cadence },
    });
  }

  /** Persist the user's timezone, falling back to UTC on an invalid/missing IANA name. */
  async setTimezone(discordId: string, tz: string): Promise<string> {
    const valid = tz && VALID_TIMEZONES.includes(tz) ? tz : 'UTC';
    await prisma.user.update({
      where: { discordId },
      data: { timezone: valid },
    });
    return valid;
  }
}
