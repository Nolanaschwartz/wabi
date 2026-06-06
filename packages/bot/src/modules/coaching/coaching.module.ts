import { Module } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { CoachingService } from './coaching.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';
import { BurstCoalescerModule } from '../burst-coalescer/burst-coalescer.module';
import { LangfuseModule } from '../langfuse/langfuse.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    SessionBufferModule,
    StrategyRetrievalModule,
    BurstCoalescerModule,
    LangfuseModule,
    BillingModule,
  ],
  providers: [ClassifierService, CoachService, CoachingService],
  exports: [CoachingService],
})
export class CoachingModule {}
