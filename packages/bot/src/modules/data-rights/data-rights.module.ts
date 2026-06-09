import { Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DataRightsController } from './data-rights.controller';
import { MemoryModule } from '../memory/memory.module';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';

@Module({
  imports: [MemoryModule, SessionBufferModule],
  providers: [DataRightsService, DataRightsController],
  exports: [DataRightsService],
})
export class DataRightsModule {}
