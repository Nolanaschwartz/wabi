import { Module } from '@nestjs/common';
import { TiltService } from './tilt.service';
import { TiltController } from './tilt.controller';
import { StrategyRetrievalModule } from '../strategy-retrieval/strategy-retrieval.module';

@Module({
  imports: [StrategyRetrievalModule],
  providers: [TiltService, TiltController],
  exports: [TiltService],
})
export class TiltModule {}
