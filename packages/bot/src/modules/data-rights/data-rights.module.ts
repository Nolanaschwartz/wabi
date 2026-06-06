import { Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DataRightsController } from './data-rights.controller';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [DataRightsService],
  controllers: [DataRightsController],
  exports: [DataRightsService],
})
export class DataRightsModule {}
