import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { StrategyTrustGate } from './strategy-trust-gate';
import { StrategyAdminService } from './strategy-admin.service';
import { StrategyAdminController } from './strategy-admin.controller';
import { AdminGuard } from './admin.guard';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';

@Module({
  imports: [StrategyRetrievalModule],
  controllers: [StrategyAdminController],
  providers: [
    { provide: StrategyTrustGate, useValue: new StrategyTrustGate() },
    StrategyAdminService,
    AdminGuard,
  ],
  exports: [StrategyAdminService],
})
export class StrategyAdminModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly service: StrategyAdminService) {}

  async onModuleInit(): Promise<void> {
    await this.service.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.service.destroy();
  }
}
