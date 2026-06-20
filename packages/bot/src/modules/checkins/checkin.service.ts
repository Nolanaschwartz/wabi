import { Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { CheckInScheduler } from './checkin-timing';
import { CoachingService } from '../coaching/coaching.service';
import { JobRegistry } from '../scheduler/job-registry';
import { Job } from '../scheduler/jobs';
import { mapWithConcurrency } from '../../lib/concurrency';

const CHECK_IN_CRON = '0 */4 * * *';
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

// Cap on simultaneous DM sends per cron tick. discord.js serializes the actual HTTP under its
// per-route limiter, so a higher number buys little wall-clock past the limiter window while pinning
// one promise + closure per user in heap. ponytail: bump if a large due cohort ever needs faster drain.
const CHECK_IN_CONCURRENCY = 5;

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
    // limiter, and the per-user try/catch keeps one blocked-DM failure from sinking the batch. The
    // fan-out is capped at CHECK_IN_CONCURRENCY so a large due cohort can't balloon heap mid-tick.
    await mapWithConcurrency(dueUsers, CHECK_IN_CONCURRENCY, async (user) => {
      try {
        await this.client.users.send(user.discordId, {
          content: 'Hey there! How are you doing today?',
        });

        await this.scheduler.recordCheckIn(user.discordId);
      } catch {
        // User may have blocked DMs
      }
    });
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
