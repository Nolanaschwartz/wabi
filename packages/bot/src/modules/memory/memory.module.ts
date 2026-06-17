import { Module } from '@nestjs/common';
import { MemoryStoreService } from './memory-store.service';
import { InnerStateMemoryService } from './inner-state-memory.service';
import { InnerStateConsentService } from './inner-state-consent.service';
import { MemoryConsentController } from './memory-consent.controller';
import { UserModule } from '../user/user.module';

// Mining is handled by SessionSweeper (session-buffer module), not here. MemoryModule provides
// only the self-hosted MemoryStore client and its consent/memory services.
@Module({
  imports: [UserModule],
  providers: [
    MemoryStoreService,
    InnerStateMemoryService,
    InnerStateConsentService,
    MemoryConsentController,
  ],
  exports: [MemoryStoreService, InnerStateMemoryService, InnerStateConsentService],
})
export class MemoryModule {}
