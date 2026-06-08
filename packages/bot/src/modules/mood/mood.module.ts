import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController, FeelingController } from './mood.controller';

@Module({
  providers: [MoodService, MoodController, FeelingController],
  exports: [MoodService],
})
export class MoodModule {}
