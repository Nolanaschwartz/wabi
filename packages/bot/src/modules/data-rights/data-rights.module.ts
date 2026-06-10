import { Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DataRightsController } from './data-rights.controller';
import { MemoryModule } from '../memory/memory.module';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [MemoryModule, SessionBufferModule, UserModule],
  providers: [DataRightsService, DataRightsController],
  exports: [DataRightsService],
})
export class DataRightsModule {}
