import { Module } from '@nestjs/common';
import { CoachService } from './coach.service';
import { CoachingService } from './coaching.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';
import { BurstCoalescerModule } from '../burst-coalescer/burst-coalescer.module';
import { LangfuseModule } from '../langfuse/langfuse.module';
import { BillingModule } from '../billing/billing.module';
import { MemoryModule } from '../memory/memory.module';
import { CrisisAftermathModule } from '../crisis-aftermath/crisis-aftermath.module';
import { CrisisModule } from '../crisis/crisis.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';
import { TiltModule } from '../tilt/tilt.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    SessionBufferModule,
    StrategyRetrievalModule,
    BurstCoalescerModule,
    LangfuseModule,
    BillingModule,
    MemoryModule,
    CrisisAftermathModule,
    CrisisModule,
    HabitEngagementModule,
    TiltModule,
    UserModule,
  ],
  providers: [CoachService, CoachingService],
  // CoachService is exported so importing modules (e.g. JournalModule) can inject it and share the
  // singleton. The Crisis Classifier now lives in CrisisModule (ADR-0006/0028), which exports it.
  exports: [CoachingService, CoachService],
})
export class CoachingModule {}
