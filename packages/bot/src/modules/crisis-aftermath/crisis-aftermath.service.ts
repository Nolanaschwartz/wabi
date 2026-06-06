import { PgBoss } from 'pg-boss';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../session-buffer/session-buffer.service';

const FOLLOW_UP_DELAY_MINUTES = 30;
const FOLLOW_UP_MESSAGES = [
  "Hey, I'm still here. How are you doing now?",
  "Just checking in - want to talk about anything?",
  "I've been thinking about our conversation. How are you feeling?",
];

export class CrisisAftermathService {
  private bossClient: PgBoss | null = null;
  private enabled: boolean;

  constructor(
    private readonly sessionBuffer: SessionBufferService,
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
