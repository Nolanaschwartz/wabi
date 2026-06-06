import { Module } from '@nestjs/common';
import { AccessResolver } from './access-resolver';
import { StripeWebhookController } from './stripe-webhook.controller';

@Module({
  controllers: [StripeWebhookController],
  providers: [AccessResolver],
  exports: [AccessResolver],
})
export class BillingModule {}
