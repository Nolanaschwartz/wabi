import { Controller, Post, Req, Res, RawBodyRequest } from '@nestjs/common';
import { StripeAccessMapper, type StripeWebhookEvent } from './stripe-access-mapper';
import { AccessResolver } from './access-resolver';

@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly accessResolver: AccessResolver) {}

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

    if (!this.verifySignature(rawBody, signature, webhookSecret)) {
      res.status(401).send('Invalid signature');
      return;
    }

    try {
      const event = JSON.parse(rawBody.toString()) as StripeWebhookEvent;
      const state = StripeAccessMapper.map(event);

      if (!state) {
        res.status(200).send('Ignored');
        return;
      }

      const discordId = event.data.customerId;
      await this.accessResolver.apply(discordId, state);

      res.status(200).send('OK');
    } catch {
      res.status(500).send('Internal error');
    }
  }

  private verifySignature(
    payload: Buffer,
    signature: string,
    secret: string,
  ): boolean {
    const [timestamp, signed] = signature.split('v1,');
    if (!timestamp || !signed) return false;

    const expected = this.hmacSHA256(
      `${timestamp}.${payload.toString()}`,
      secret,
    );

    return this.constantTimeCompare(expected, signed);
  }

  private hmacSHA256(data: string, key: string): string {
    const crypto = require('crypto');
    return crypto
      .createHmac('sha256', key)
      .update(data)
      .digest('hex');
  }

  private constantTimeCompare(a: string, b: string): boolean {
    const crypto = require('crypto');
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}
