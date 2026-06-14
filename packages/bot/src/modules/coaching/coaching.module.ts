import { Module } from '@nestjs/common';
import { CoachingService } from './coaching.service';
import { CoachHandler } from './coach-handler';
import { DmRouterService } from './dm-router.service';
import { CoachModelModule } from './coach-model.module';
import { JournalModule } from '../journal/journal.module';
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
import { MoodModule } from '../mood/mood.module';
import { UserModule } from '../user/user.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { SpokeSessionModule } from '../spoke-session/spoke-session.module';

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
    MoodModule,
    UserModule,
    IntentRouterModule,
    CoachModelModule,
    // The DM router dispatches to JournalDmHandler. JournalModule depends only on CoachModelModule (not
    // CoachingModule), so importing it here forms no cycle. (Crisis Classifier lives in CrisisModule.)
    JournalModule,
    // The hub router reads/consumes the spoke floor for two-turn continuity.
    SpokeSessionModule,
  ],
  providers: [CoachingService, CoachHandler, DmRouterService],
  // Re-export CoachModelModule so existing consumers that resolve CoachService through CoachingModule
  // keep working after the model adapter moved into its own module.
  exports: [CoachingService, CoachModelModule],
})
export class CoachingModule {}
