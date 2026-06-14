import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { JournalDmHandler } from './journal-dm.handler';
import { CoachModelModule } from '../coaching/coach-model.module';
import { MemoryModule } from '../memory/memory.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';
import { CrisisModule } from '../crisis/crisis.module';
import { SpokeSessionModule } from '../spoke-session/spoke-session.module';

@Module({
  // Depends on CoachModelModule (just the LLM adapter) rather than CoachingModule, so the DM router in
  // CoachingModule can import this module to reach JournalDmHandler without a module cycle.
  // InnerStateLoggerModule supplies the transport-free InnerStateRecorderService (the shared screened-
  // record tail); CrisisModule supplies the DM mint (screenedFromUpstream). Together the DM handler is
  // the DM adapter over the same path as the slash command (ADR-0031).
  imports: [
    CoachModelModule,
    MemoryModule,
    HabitEngagementModule,
    InnerStateLoggerModule,
    CrisisModule,
    // JournalDmHandler arms the spoke floor on a bare journal intent (two-turn capture).
    SpokeSessionModule,
  ],
  providers: [JournalService, JournalController, JournalDmHandler],
  exports: [JournalService, JournalDmHandler],
})
export class JournalModule {}
