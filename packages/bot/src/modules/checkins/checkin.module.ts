import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CheckInService } from './checkin.service';
import { CheckInController } from './checkin.controller';
import { CheckInScheduler } from './checkin-timing';
import { CoachingModule } from '../coaching/coaching.module';

@Module({
  imports: [CoachingModule],
  providers: [CheckInService, CheckInScheduler, CheckInController],
  exports: [CheckInService],
})
export class CheckInModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly service: CheckInService) {}

  // Without this the scheduler was inert: init() (cron + worker) was defined but never called, so
  // periodic check-in DMs never fired. Mirrors the other pg-boss modules (e.g. CrisisAftermath).
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.service.destroy();
  }
}
