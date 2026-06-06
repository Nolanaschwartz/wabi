import { Module } from '@nestjs/common';
import { PlaytimeService } from './playtime.service';
import { PlaytimeController } from './playtime.controller';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [PlaytimeService, PlaytimeController],
  exports: [PlaytimeService],
})
export class PlaytimeModule {}
