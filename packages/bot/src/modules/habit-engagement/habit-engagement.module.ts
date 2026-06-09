import { Module } from '@nestjs/common';
import { HabitEngagementService } from './habit-engagement.service';
import { XpModule } from '../xp/xp.module';
import { StreaksModule } from '../streaks/streaks.module';

@Module({
  imports: [XpModule, StreaksModule],
  providers: [HabitEngagementService],
  exports: [HabitEngagementService],
})
export class HabitEngagementModule {}
