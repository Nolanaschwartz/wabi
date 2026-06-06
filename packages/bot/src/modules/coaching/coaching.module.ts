import { Module } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { CoachingService } from './coaching.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';

@Module({
  imports: [SessionBufferModule, StrategyRetrievalModule],
  providers: [ClassifierService, CoachService, CoachingService],
  exports: [CoachingService],
})
export class CoachingModule {}
