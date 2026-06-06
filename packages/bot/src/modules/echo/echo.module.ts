import { Module } from '@nestjs/common';
import { EchoController } from './echo.controller';
import { CrisisModule } from '../crisis/crisis.module';
import { CoachingModule } from '../coaching/coaching.module';
import { CrisisAftermathModule } from '../crisis-aftermath/crisis-aftermath.module';

@Module({
  providers: [EchoController],
  imports: [CrisisModule, CoachingModule, CrisisAftermathModule],
})
export class EchoModule {}
