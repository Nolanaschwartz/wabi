import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { CheckInScheduler } from './checkin-timing';
import { CoachingService } from '../coaching/coaching.service';

const CHECK_IN_CRON = '0 */4 * * *';
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

@Injectable()
export class CheckInService {
  private bossClient: PgBoss | null = null;

  constructor(
    private readonly scheduler: CheckInScheduler,
    private readonly coachingService: CoachingService,
    private readonly client: Client,
  ) {}

  async init(): Promise<void> {
    if (!process.env.DATABASE_URL) return;

    try {
      this.bossClient = new PgBoss({
        connectionString: process.env.DATABASE_URL,
      });
      await this.bossClient.start();
      await this.bossClient.createQueue('check-in-scheduler');
      await this.bossClient.schedule('check-in-scheduler', CHECK_IN_CRON);
      await this.bossClient.work('check-in-scheduler', this.handleCheckIns.bind(this));
    } catch {
      // Graceful degradation
    }
  }

  private async handleCheckIns(): Promise<void> {
    const dueUsers = await this.scheduler.findDueUsers();

    for (const user of dueUsers) {
      try {
        await this.client.users.send(user.discordId, {
          content: 'Hey there! How are you doing today?',
        });

        await this.scheduler.recordCheckIn(user.discordId);
      } catch {
        // User may have blocked DMs
      }
    }
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

  async setTimezone(discordId: string, tz: string): Promise<void> {
    const valid = VALID_TIMEZONES.includes(tz) ? tz : 'UTC';
    await prisma.user.update({
      where: { discordId },
      data: { timezone: valid },
    });
  }

  async destroy(): Promise<void> {
    if (this.bossClient) {
      await this.bossClient.stop();
    }
  }
}
