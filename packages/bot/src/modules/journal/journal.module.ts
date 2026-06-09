import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { CoachingModule } from '../coaching/coaching.module';
import { CrisisModule } from '../crisis/crisis.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';

@Module({
  imports: [CoachingModule, CrisisModule, HabitEngagementModule],
  providers: [JournalService, JournalController],
  exports: [JournalService],
})
export class JournalModule {}
