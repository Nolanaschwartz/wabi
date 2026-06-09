import { Module } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
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
import { StreaksModule } from '../streaks/streaks.module';
import { TiltModule } from '../tilt/tilt.module';

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
    StreaksModule,
    TiltModule,
  ],
  providers: [ClassifierService, CoachService, CoachingService],
  // ClassifierService and CoachService are exported so importing modules (e.g. JournalModule)
  // can inject them and share these singletons instead of failing DI resolution at boot.
  exports: [CoachingService, ClassifierService, CoachService],
})
export class CoachingModule {}
