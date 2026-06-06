import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MemoryStoreService } from './memory-store.service';
import { MemorySweeperService } from './memory-sweeper.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { SessionBufferService } from '../session-buffer/session-buffer.service';

@Module({
  imports: [SessionBufferModule],
  providers: [MemoryStoreService, MemorySweeperService],
  exports: [MemoryStoreService],
})
export class MemoryModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly sweeper: MemorySweeperService) {}

  async onModuleInit(): Promise<void> {
    await this.sweeper.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.sweeper.destroy();
  }
}
