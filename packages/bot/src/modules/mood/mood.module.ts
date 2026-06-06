import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController } from './mood.controller';

@Module({
  providers: [MoodService],
  controllers: [MoodController],
  exports: [MoodService],
})
export class MoodModule {}
