import { Module } from '@nestjs/common';
import { InnerStateLoggerService } from './inner-state-logger.service';
import { InnerStateRecorderService } from './inner-state-recorder.service';
import { CrisisModule } from '../crisis/crisis.module';
import { MemoryModule } from '../memory/memory.module';

// Owns the screened-record write path for the free-text inner-state commands (Mood / Tilt / Journal).
// The transport-free tail (InnerStateRecorderService) composes the derive + consent seams (MemoryModule);
// the slash adapter (InnerStateLoggerService) adds the crisis mint (CrisisModule) and discord.js
// lifecycle. The recorder is exported so the DM surface can render its Outcome too (ADR-0031).
@Module({
  imports: [CrisisModule, MemoryModule],
  providers: [InnerStateLoggerService, InnerStateRecorderService],
  exports: [InnerStateLoggerService, InnerStateRecorderService],
})
export class InnerStateLoggerModule {}
