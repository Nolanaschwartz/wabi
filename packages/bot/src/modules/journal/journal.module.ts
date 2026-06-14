import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { JournalDmHandler } from './journal-dm.handler';
import { CoachModelModule } from '../coaching/coach-model.module';
import { MemoryModule } from '../memory/memory.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';
import { SpokeSessionModule } from '../spoke-session/spoke-session.module';

@Module({
  // Depends on CoachModelModule (just the LLM adapter) rather than CoachingModule, so the DM router in
  // CoachingModule can import this module to reach JournalDmHandler without a module cycle. MemoryModule
  // supplies InnerStateMemoryService for the DM handler's consent-gated derivation.
  imports: [
    CoachModelModule,
    MemoryModule,
    HabitEngagementModule,
    InnerStateLoggerModule,
    // JournalDmHandler arms the spoke floor on a bare journal intent (two-turn capture).
    SpokeSessionModule,
  ],
  providers: [JournalService, JournalController, JournalDmHandler],
  exports: [JournalService, JournalDmHandler],
})
export class JournalModule {}
