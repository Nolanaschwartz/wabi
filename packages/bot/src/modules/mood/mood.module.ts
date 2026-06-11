import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController, FeelingController } from './mood.controller';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';

@Module({
  imports: [InnerStateLoggerModule],
  providers: [MoodService, MoodController, FeelingController],
  exports: [MoodService],
})
export class MoodModule {}
