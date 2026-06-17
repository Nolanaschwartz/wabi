import { Module } from '@nestjs/common';
import { AccessResolver } from './access-resolver';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  controllers: [StripeWebhookController],
  providers: [AccessResolver, StripeService],
  exports: [AccessResolver, StripeService],
})
export class BillingModule {}
