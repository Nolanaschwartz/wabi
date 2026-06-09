import { Module, OnModuleInit } from '@nestjs/common';
import { TiltService } from './tilt.service';
import { TiltController } from './tilt.controller';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [StrategyRetrievalModule, SchedulerModule],
  providers: [TiltService, TiltController],
  exports: [TiltService],
})
export class TiltModule implements OnModuleInit {
  constructor(private readonly service: TiltService) {}

  // Registers the auto-resolve cron on the shared Scheduler (started by SchedulerModule first).
  // Stopping the client is the Scheduler's job now, so there's no onModuleDestroy here.
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }
}
