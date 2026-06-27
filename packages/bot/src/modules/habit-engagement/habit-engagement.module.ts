import { Module } from '@nestjs/common';
import { HabitEngagementService } from './habit-engagement.service';
import { ProfileController } from './profile.controller';
import { XpModule } from '../xp/xp.module';
import { StreaksModule } from '../streaks/streaks.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  // BillingModule exports AccessResolver — the single source the coaching path uses to resolve a
  // person's timezone. /profile reuses it so the Streak/Wellness numbers agree across surfaces.
  imports: [XpModule, StreaksModule, BillingModule],
  providers: [HabitEngagementService, ProfileController],
  exports: [HabitEngagementService],
})
export class HabitEngagementModule {}
