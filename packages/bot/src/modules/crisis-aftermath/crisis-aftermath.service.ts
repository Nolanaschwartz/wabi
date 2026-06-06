import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';

const FOLLOW_UP_DELAY_MINUTES = 30;
const FOLLOW_UP_MESSAGES = [
  "Hey, I'm still here. How are you doing now?",
  "Just checking in - want to talk about anything?",
  "I've been thinking about our conversation. How are you feeling?",
];

@Injectable()
export class CrisisAftermathService {
  private bossClient: PgBoss | null = null;
  private enabled: boolean;

  constructor(
    private readonly sessionBuffer: SessionBufferService,
    private readonly coachingSession: CoachingSessionService,
  ) {
    this.enabled = !!process.env.DATABASE_URL;
  }

  async init(): Promise<void> {
    if (!this.enabled) return;

    try {
      this.bossClient = new PgBoss({
        connectionString: process.env.DATABASE_URL,
      });
      await this.bossClient.start();
      await this.bossClient.createQueue('crisis-follow-up');
      await this.bossClient.work('crisis-follow-up', this.followUpJob.bind(this));
    } catch {
      // Graceful degradation
    }
  }

  async onEscalation(userId: string): Promise<void> {
    // Single source of truth for "never mine this session": the Postgres do-not-mine flag the
    // sweeper reads. Set on BOTH crisis paths (classifier + tripwire), since onEscalation is the
    // one call both make. The Redis buffer clear + quarantine key are the time-bounded aftermath
    // window, a separate concern. (Issue #24 / ADR-0010/0016.)
    await this.coachingSession.quarantine(userId);
    await this.sessionBuffer.clearAndQuarantine(userId);

    if (!this.bossClient) return;

    const followUpMessage = FOLLOW_UP_MESSAGES[
      Math.floor(Math.random() * FOLLOW_UP_MESSAGES.length)
    ];

    try {
      await this.bossClient.schedule(
        'crisis-follow-up',
        `${FOLLOW_UP_DELAY_MINUTES} minutes`,
        {
          userId,
          message: followUpMessage,
        },
      );
    } catch {
      // Best-effort scheduling
    }
  }

  private async followUpJob(job: unknown[]): Promise<void> {
    try {
      const data = job[0] as { userId: string };
      await prisma.escalationEvent.create({
        data: {
          userId: data.userId,
          layer: 'follow-up',
        },
      });
    } catch {
      // Non-critical
    }
  }

  async isQuarantined(userId: string): Promise<boolean> {
    try {
      const raw = await this.sessionBuffer.getContext(userId);
      if (raw) return false;

      const client = (this.sessionBuffer as any).client;
      if (!client) return false;

      const value = await client.get(`wabi:quarantine:${userId}`);
      return value === 'true';
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    if (this.bossClient) {
      await this.bossClient.stop();
    }
  }
}
