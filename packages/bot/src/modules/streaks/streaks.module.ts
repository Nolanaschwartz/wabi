import { Module } from '@nestjs/common';
import { StreaksService } from './streaks.service';
import { StreaksController } from './streaks.controller';
import { XpModule } from '../xp/xp.module';

@Module({
  imports: [XpModule],
  providers: [StreaksService, StreaksController],
  exports: [StreaksService],
})
export class StreaksModule {}
