import { Module } from '@nestjs/common';
import { InnerStateLoggerService } from './inner-state-logger.service';
import { CrisisModule } from '../crisis/crisis.module';
import { MemoryModule } from '../memory/memory.module';

// Owns the screened-record write path for the free-text inner-state commands (Mood / Tilt / Journal).
// It composes the crisis seam (CrisisModule) with the derive + consent seams (MemoryModule); those
// modules stay the single source of each behaviour — this module only orders them.
@Module({
  imports: [CrisisModule, MemoryModule],
  providers: [InnerStateLoggerService],
  exports: [InnerStateLoggerService],
})
export class InnerStateLoggerModule {}
