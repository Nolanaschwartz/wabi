import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TiltService } from './tilt.service';
import { TiltController } from './tilt.controller';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';

@Module({
  imports: [StrategyRetrievalModule],
  providers: [TiltService, TiltController],
  exports: [TiltService],
})
export class TiltModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly service: TiltService) {}

  async onModuleInit(): Promise<void> {
    await this.service.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.service.destroy();
  }
}
