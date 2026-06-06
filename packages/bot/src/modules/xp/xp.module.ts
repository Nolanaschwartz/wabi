import { Module } from '@nestjs/common';
import { XpService } from './xp.service';

@Module({
  providers: [XpService],
  exports: [XpService],
})
export class XpModule {}
