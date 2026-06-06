import { Module } from '@nestjs/common';
import { StreaksService } from './streaks.service';
import { StreaksController } from './streaks.controller';

@Module({
  providers: [StreaksService, StreaksController],
  exports: [StreaksService],
})
export class StreaksModule {}
