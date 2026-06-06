import { Module } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { CoachingService } from './coaching.service';

@Module({
  providers: [ClassifierService, CoachService, CoachingService],
  exports: [CoachingService],
})
export class CoachingModule {}
