import { Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DataRightsController } from './data-rights.controller';
import { DataRightsApiController } from './data-rights-api.controller';
import { DataRightsApiGuard } from './data-rights-api.guard';
import { MemoryModule } from '../memory/memory.module';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [MemoryModule, SessionBufferModule, UserModule],
  controllers: [DataRightsApiController],
  providers: [DataRightsService, DataRightsController, DataRightsApiGuard],
  exports: [DataRightsService],
})
export class DataRightsModule {}
