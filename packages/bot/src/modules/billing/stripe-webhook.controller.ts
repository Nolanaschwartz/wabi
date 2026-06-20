import { Controller, Post, Req, Res, RawBodyRequest } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'http';
import Stripe from 'stripe';
import { mapStripeEvent, type StripeWebhookEvent } from './stripe-access-mapper';
import { AccessResolver } from './access-resolver';
import { StripeService } from './stripe.service';
import { prisma } from '@wabi/shared';

// What this controller actually reads off the injected express request. A structural type — not the
// DOM `Request` the generic would otherwise resolve to (whose `headers` is a `Headers` object, forcing
// the old `as any`) — so `req.headers` is the Node header bag and bracket access is properly typed.
type StripeWebhookRequest = RawBodyRequest<{ headers: IncomingHttpHeaders }>;

// The verified Stripe event, inferred from the SDK client's constructEvent. The SDK's `Stripe.Event`
// namespace type isn't directly nameable under this module mode (the package is `export =`, which hides
// the core namespace), so we derive it from the call signature — full structural typing, no `any`.
type StripeEvent = ReturnType<InstanceType<typeof Stripe>['webhooks']['constructEvent']>;

@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    private readonly accessResolver: AccessResolver,
    private readonly stripeService: StripeService,
  ) {}

  @Post()
  async handle(
    @Req() req: StripeWebhookRequest,
    @Res() res: { status: (code: number) => { send: (body: string) => void } },
  ): Promise<void> {
    const signature = req.headers['stripe-signature'];
    const rawBody = req.rawBody ?? Buffer.from('');

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = this.stripeService.getClient();
    if (!webhookSecret || !signature || !stripe) {
      res.status(400).send('Missing webhook config');
      return;
    }

    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(
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
      const state = mapStripeEvent(stripeEvent);

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

      // Out-of-order guard (#27): Stripe does not guarantee delivery order. A stale
      // `updated` (active) delivered after a `deleted` must not resurrect access. Compare the
      // event's creation time against the last applied one and drop anything strictly older.
      // (Exact redeliveries are already short-circuited by the event-id dedup above.)
      const eventCreatedAt = new Date((event.created ?? 0) * 1000);
      if (user.lastStripeEventAt && eventCreatedAt < user.lastStripeEventAt) {
        await this.markProcessed(event.id);
        res.status(200).send('Stale');
        return;
      }

      await this.accessResolver.apply(user.discordId, state, eventCreatedAt);
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

  // Caller has already confirmed event.type is one of the three subscription events, so data.object is
  // a subscription — narrow to the fields we read (a documented structural cast, not an `any` escape
  // hatch). `customer` is the id string on webhooks but may be an (un)expanded object, so handle both;
  // `status` is asserted into the four values we map (mapStripeEvent folds the rest into trialing).
  private toWebhookEvent(event: StripeEvent): StripeWebhookEvent {
    const sub = event.data.object as {
      customer: string | { id: string };
      status: StripeWebhookEvent['data']['status'];
    };
    return {
      id: event.id,
      type: event.type,
      data: {
        customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        status: sub.status,
      },
    };
  }
}
