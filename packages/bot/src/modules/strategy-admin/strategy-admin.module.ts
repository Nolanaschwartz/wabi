import { Module } from '@nestjs/common';
import { StrategyTrustGate } from './strategy-trust-gate';
import { StrategyAdminService } from './strategy-admin.service';

@Module({
  providers: [
    { provide: StrategyTrustGate, useValue: new StrategyTrustGate() },
    StrategyAdminService,
  ],
  exports: [StrategyAdminService],
})
export class StrategyAdminModule {}
