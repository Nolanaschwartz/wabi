import { Module } from '@nestjs/common';
import { HelpController } from './help.controller';

@Module({
  providers: [HelpController],
})
export class HelpModule {}
