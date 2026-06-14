import { Module } from '@nestjs/common';
import { IntentRouterService } from './intent-router.service';

@Module({
  providers: [IntentRouterService],
  exports: [IntentRouterService],
})
export class IntentRouterModule {}
