import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { CoachingModule } from '../coaching/coaching.module';
import { HabitEngagementModule } from '../habit-engagement/habit-engagement.module';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';

@Module({
  imports: [CoachingModule, HabitEngagementModule, InnerStateLoggerModule],
  providers: [JournalService, JournalController],
  exports: [JournalService],
})
export class JournalModule {}
