import { Module } from '@nestjs/common';
import { EchoController } from './echo.controller';
import { CrisisModule } from '../crisis/crisis.module';
import { CoachingModule } from '../coaching/coaching.module';

@Module({
  controllers: [EchoController],
  imports: [CrisisModule, CoachingModule],
})
export class EchoModule {}
