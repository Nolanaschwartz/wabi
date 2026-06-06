import { Controller, Post, Req, Res, RawBodyRequest } from '@nestjs/common';
import { StripeAccessMapper, type StripeWebhookEvent } from './stripe-access-mapper';
import { AccessResolver } from './access-resolver';
import { prisma } from '@wabi/shared';
import Stripe from 'stripe';

@Controller('webhooks/stripe')
export class StripeWebhookController {
  private stripe: InstanceType<typeof Stripe>;

  constructor(private readonly accessResolver: AccessResolver) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      typescript: true,
    });
  }

  @Post()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: { status: (code: number) => { send: (body: string) => void } },
  ): Promise<void> {
    const signature = (req.headers as any)['stripe-signature'] as string;
    const rawBody = req.rawBody ?? Buffer.from('');

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !signature) {
      res.status(400).send('Missing webhook config');
      return;
    }

    let event: any;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody.toString(),
        signature,
        webhookSecret,
      );
    } catch {
      res.status(401).send('Invalid signature');
      return;
    }

    if (event.type !== 'customer.subscription.created' &&
        event.type !== 'customer.subscription.updated' &&
        event.type !== 'customer.subscription.deleted') {
      res.status(200).send('Ignored');
      return;
    }

    try {
      const processed = await this.isProcessed(event.id);
      if (processed) {
        res.status(200).send('Duplicate');
        return;
      }

      const stripeEvent = this.toWebhookEvent(event);
      const state = StripeAccessMapper.map(stripeEvent);

      if (!state) {
        res.status(200).send('Ignored');
        return;
      }

      const user = await prisma.user.findFirst({
        where: { stripeCustomerId: stripeEvent.data.customerId },
      });

      if (!user) {
        res.status(404).send('User not found');
        return;
      }

      await this.accessResolver.apply(user.discordId, state);
      await this.markProcessed(event.id);

      res.status(200).send('OK');
    } catch {
      res.status(500).send('Internal error');
    }
  }

  private async isProcessed(eventId: string): Promise<boolean> {
    const existing = await prisma.processedStripeEvent.findUnique({
      where: { id: eventId },
    });
    return !!existing;
  }

  private async markProcessed(eventId: string): Promise<void> {
    try {
      await prisma.processedStripeEvent.create({
        data: {
          id: eventId,
          type: 'stripe_event',
        },
      });
    } catch {
      // Duplicate — already processed by concurrent request
    }
  }

  private toWebhookEvent(event: any): StripeWebhookEvent {
    const sub = event.data.object as any;
    return {
      id: event.id,
      type: event.type,
      data: {
        customerId: sub.customer as string,
        status: sub.status,
      },
    };
  }
}
