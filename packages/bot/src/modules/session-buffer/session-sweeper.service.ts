import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { CoachingSessionService } from './coaching-session.service';
import { SessionBufferService } from './session-buffer.service';
import { MemoryStoreService } from '../memory/memory-store.service';
import { JobRegistry } from '../scheduler/job-registry';
import { Job } from '../scheduler/jobs';

export interface SweepResult {
  sessionsEnded: number;
  mined: number;
  skipped: number;
}

const SWEEP_CRON = '*/5 * * * *';

@Injectable()
export class SessionSweeper implements OnModuleInit {
  constructor(
    private readonly coachingSession: CoachingSessionService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly memoryStore: MemoryStoreService,
    private readonly jobs: JobRegistry,
  ) {}

  onModuleInit() {
    // Declare the sweep cron; the Scheduler drains the registry and binds it at bootstrap.
    this.jobs.declare({
      name: Job.SessionSweep,
      kind: 'cron',
      cron: SWEEP_CRON,
      owner: 'session-buffer',
      handler: async () => {
        await this.sweep();
      },
    });
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
