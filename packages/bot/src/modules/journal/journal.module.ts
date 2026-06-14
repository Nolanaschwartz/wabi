import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { JournalDmHandler } from './journal-dm.handler';
import { JournalSessionService } from './journal-session.service';
import { CoachModelModule } from '../coaching/coach-model.module';
import { MemoryModule } from '../memory/memory.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';

@Module({
  // Depends on CoachModelModule (just the LLM adapter) rather than CoachingModule, so the DM router in
  // CoachingModule can import this module to reach JournalDmHandler without a module cycle. MemoryModule
  // supplies InnerStateMemoryService for the DM handler's consent-gated derivation.
  imports: [CoachModelModule, MemoryModule, HabitEngagementModule, InnerStateLoggerModule],
  providers: [
    JournalService,
    JournalController,
    JournalDmHandler,
    // Connect the pending-journal Redis client at module init, mirroring SessionBufferService — the
    // bot must come online even if Redis is down (degraded), so init swallows connect failures.
    {
      provide: JournalSessionService,
      useFactory: async () => {
        const svc = new JournalSessionService();
        await svc.init();
        return svc;
      },
    },
  ],
  exports: [JournalService, JournalDmHandler, JournalSessionService],
})
export class JournalModule {}
