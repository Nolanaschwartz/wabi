import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { CoachingSessionService } from './coaching-session.service';
import { SessionBufferService } from './session-buffer.service';
import { MemoryStoreService } from '../memory/memory-store.service';

export interface SweepResult {
  sessionsEnded: number;
  mined: number;
  skipped: number;
}

@Injectable()
export class SessionSweeper implements OnModuleInit {
  private sweepIntervalMs = 5 * 60 * 1000;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly coachingSession: CoachingSessionService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  async onModuleInit() {
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
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

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
