import { Module, OnModuleInit } from '@nestjs/common';
import { StrategyTrustGate } from './strategy-trust-gate';
import { StrategyAdminService } from './strategy-admin.service';
import { StrategyAdminController } from './strategy-admin.controller';
import { AdminGuard } from './admin.guard';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [StrategyRetrievalModule, SchedulerModule],
  controllers: [StrategyAdminController],
  providers: [
    { provide: StrategyTrustGate, useValue: new StrategyTrustGate() },
    StrategyAdminService,
    AdminGuard,
  ],
  exports: [StrategyAdminService],
})
export class StrategyAdminModule implements OnModuleInit {
  constructor(private readonly service: StrategyAdminService) {}

  // Registers the demote worker on the shared Scheduler; the client lifecycle is the Scheduler's.
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }
}
