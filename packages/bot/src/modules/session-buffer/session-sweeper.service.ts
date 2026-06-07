import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { prisma } from '@wabi/shared';
import { CoachingSessionService } from './coaching-session.service';
import { SessionBufferService } from './session-buffer.service';
import { MemoryStoreService } from '../memory/memory-store.service';

export interface SweepResult {
  sessionsEnded: number;
  mined: number;
  skipped: number;
}

const SWEEP_QUEUE = 'session-sweeper';
const SWEEP_CRON = '*/5 * * * *';

@Injectable()
export class SessionSweeper implements OnModuleInit, OnModuleDestroy {
  private bossClient: PgBoss | null = null;

  constructor(
    private readonly coachingSession: CoachingSessionService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;

    try {
      this.bossClient = new PgBoss({
        connectionString: process.env.DATABASE_URL,
      });
      await this.bossClient.start();
      await this.bossClient.createQueue(SWEEP_QUEUE);
      await this.bossClient.schedule(SWEEP_QUEUE, SWEEP_CRON);
      await this.bossClient.work(SWEEP_QUEUE, async () => {
        await this.sweep();
      });
    } catch {
      // Graceful degradation
    }
  }

  async onModuleDestroy() {
    if (this.bossClient) {
      await this.bossClient.stop();
    }
  }

  async sweep(): Promise<SweepResult> {
    const stale = await this.coachingSession.endStale();

    let mined = 0;
    let skipped = 0;

    for (const session of stale) {
      if (session.doNotMine) {
        await this.coachingSession.markMined(session.id);
        skipped++;
        continue;
      }

      const context = await this.sessionBuffer.getContext(session.discordId);
      if (context && context.turns.length > 0) {
        await this.memoryStore.deriveAndStore(
          session.discordId,
          context.turns.map((t) => `${t.role}: ${t.content}`).join('\n'),
        );
        await this.sessionBuffer.clear(session.discordId);
      }

      await this.coachingSession.markMined(session.id);
      mined++;
    }

    return {
      sessionsEnded: stale.length,
      mined,
      skipped,
    };
  }
}
