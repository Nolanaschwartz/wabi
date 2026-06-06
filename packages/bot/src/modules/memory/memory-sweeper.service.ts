import { PgBoss } from 'pg-boss';
import { prisma } from '@wabi/shared';
import { MemoryStoreService } from './memory-store.service';
import { SessionBufferService } from '../session-buffer/session-buffer.service';

const SWEEPER_INTERVAL_MINUTES = 30;
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export class MemorySweeperService {
  private bossClient: PgBoss | null = null;
  private enabled: boolean;

  constructor(
    private readonly memoryStore: MemoryStoreService,
    private readonly sessionBuffer: SessionBufferService,
  ) {
    this.enabled = !!(
      process.env.DATABASE_URL &&
      process.env.MEM0_API_KEY
    );
  }

  async init(): Promise<void> {
    if (!this.enabled) return;

    try {
      this.bossClient = new PgBoss({
        connectionString: process.env.DATABASE_URL,
      });
      await this.bossClient.start();
      await this.bossClient.work('memory-sweeper', this.sweeperJob.bind(this));
      await this.bossClient.schedule(
        'memory-sweeper',
        `*/${SWEEPER_INTERVAL_MINUTES} * * * *`,
      );
    } catch {
      // Graceful degradation if pg-boss fails
    }
  }

  private async sweeperJob(): Promise<void> {
    try {
      const idleThreshold = new Date(Date.now() - IDLE_THRESHOLD_MS);
      const idleSessions = await prisma.session.findMany({
        where: {
          lastActivity: { lt: idleThreshold },
          mined: false,
          doNotMine: false,
        },
        take: 50,
      });

      for (const session of idleSessions) {
        await this.processSession(session);
      }
    } catch {
      // Non-fatal — next sweep will retry
    }
  }

  private async processSession(session: {
    id: string;
    userId: string;
  }): Promise<void> {
    const redisData = await this.sessionBuffer.getContext(session.userId);
    if (!redisData) {
      await this.markMined(session.id);
      return;
    }

    const sessionText = redisData.turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n');

    try {
      const topic = await this.deriveTopic(sessionText);
      await this.memoryStore.deriveAndStore(session.userId, sessionText);
      await this.saveConversation(session.userId, topic);
    } catch {
      // Best-effort memory derivation
    }

    await this.sessionBuffer.clear(session.userId);
    await this.markMined(session.id);
  }

  private async deriveTopic(text: string): Promise<string> {
    if (text.length > 500) {
      return text.slice(0, 500) + '...';
    }
    return text;
  }

  private async saveConversation(userId: string, topic: string): Promise<void> {
    try {
      await prisma.aiConversation.create({
        data: {
          userId,
          topic,
        },
      });
    } catch {
      // Best-effort storage
    }
  }

  private async markMined(sessionId: string): Promise<void> {
    try {
      await prisma.session.update({
        where: { id: sessionId },
        data: { mined: true },
      });
    } catch {
      // Non-critical
    }
  }

  async destroy(): Promise<void> {
    if (this.bossClient) {
      await this.bossClient.stop();
    }
  }
}
