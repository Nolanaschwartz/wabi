import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController, FeelingController } from './mood.controller';
import { MoodDmHandler } from './mood-dm.handler';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';
import { SpokeSessionModule } from '../spoke-session/spoke-session.module';

@Module({
  imports: [InnerStateLoggerModule, SpokeSessionModule],
  providers: [MoodService, MoodController, FeelingController, MoodDmHandler],
  exports: [MoodService, MoodDmHandler],
})
export class MoodModule {}
