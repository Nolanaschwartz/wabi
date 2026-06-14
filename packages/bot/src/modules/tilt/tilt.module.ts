import { Module, OnModuleInit } from '@nestjs/common';
import { TiltService } from './tilt.service';
import { TiltController } from './tilt.controller';
import { TiltDmHandler } from './tilt-dm.handler';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { InnerStateLoggerModule } from '../inner-state-logger/inner-state-logger.module';

@Module({
  imports: [StrategyRetrievalModule, SchedulerModule, InnerStateLoggerModule],
  providers: [TiltService, TiltController, TiltDmHandler],
  exports: [TiltService, TiltDmHandler],
})
export class TiltModule implements OnModuleInit {
  constructor(private readonly service: TiltService) {}

  // Registers the auto-resolve cron on the shared Scheduler (started by SchedulerModule first).
  // Stopping the client is the Scheduler's job now, so there's no onModuleDestroy here.
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }
}
