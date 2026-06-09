import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController, FeelingController } from './mood.controller';
import { CrisisModule } from '../crisis/crisis.module';

@Module({
  imports: [CrisisModule],
  providers: [MoodService, MoodController, FeelingController],
  exports: [MoodService],
})
export class MoodModule {}
