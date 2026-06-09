import { Module, OnModuleInit } from '@nestjs/common';
import { CheckInService } from './checkin.service';
import { CheckInController } from './checkin.controller';
import { CheckInScheduler } from './checkin-timing';
import { CoachingModule } from '../coaching/coaching.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [CoachingModule, SchedulerModule],
  providers: [CheckInService, CheckInScheduler, CheckInController],
  exports: [CheckInService],
})
export class CheckInModule implements OnModuleInit {
  constructor(private readonly service: CheckInService) {}

  // Without this the scheduler was inert: init() (the cron registration) was defined but never
  // called, so periodic check-in DMs never fired. Mirrors the other Scheduler-backed modules.
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }
}
