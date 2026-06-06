import { Module, OnModuleInit } from '@nestjs/common';
import { StrategyRetrievalService } from './strategy-retrieval.service';

@Module({
  providers: [
    {
      provide: StrategyRetrievalService,
      useFactory: async () => {
        const svc = new StrategyRetrievalService();
        await svc.init();
        return svc;
      },
    },
  ],
  exports: [StrategyRetrievalService],
})
export class StrategyRetrievalModule implements OnModuleInit {
  async onModuleInit(): Promise<void> {}
}
