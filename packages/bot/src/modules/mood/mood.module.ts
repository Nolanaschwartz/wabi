import { Module } from '@nestjs/common';
import { MoodService } from './mood.service';
import { MoodController, FeelingController } from './mood.controller';
import { CrisisModule } from '../crisis/crisis.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [CrisisModule, MemoryModule],
  providers: [MoodService, MoodController, FeelingController],
  exports: [MoodService],
})
export class MoodModule {}
