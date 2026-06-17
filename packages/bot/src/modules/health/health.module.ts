import { Module } from '@nestjs/common';
import { HealthController, HealthService } from './health.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [SchedulerModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
