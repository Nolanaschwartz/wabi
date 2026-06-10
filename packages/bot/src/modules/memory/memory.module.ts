import { Module } from '@nestjs/common';
import { MemoryStoreService } from './memory-store.service';
import { InnerStateMemoryService } from './inner-state-memory.service';
import { InnerStateConsentService } from './inner-state-consent.service';
import { MemoryConsentController } from './memory-consent.controller';

// Mining is handled by SessionSweeper (session-buffer module), which iterates the
// CoachingSession table by Discord ID and honors do-not-mine. The old MemorySweeperService
// (wrong table, MEM0_API_KEY gate, raw-text persistence to aiConversation) was removed — see
// issue #22. MemoryModule now only provides the self-hosted MemoryStore client.
@Module({
  providers: [
    MemoryStoreService,
    InnerStateMemoryService,
    InnerStateConsentService,
    MemoryConsentController,
  ],
  exports: [MemoryStoreService, InnerStateMemoryService, InnerStateConsentService],
})
export class MemoryModule {}
