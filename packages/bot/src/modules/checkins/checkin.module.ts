import { Module } from '@nestjs/common';
import { CheckInService } from './checkin.service';
import { CheckInController } from './checkin.controller';
import { CheckInScheduler } from './checkin-timing';
import { CoachingModule } from '../coaching/coaching.module';

@Module({
  imports: [CoachingModule],
  providers: [CheckInService, CheckInScheduler],
  controllers: [CheckInController],
  exports: [CheckInService],
})
export class CheckInModule {}
