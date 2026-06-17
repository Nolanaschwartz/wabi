import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

/**
 * The bot's one Stripe client. Built lazily: constructing it eagerly with an empty key throws and
 * would crash the bot at boot when Stripe is unconfigured (e.g. local dev), so callers degrade
 * gracefully when `getClient()` returns null. Shared by the webhook controller and account deletion.
 */
@Injectable()
export class StripeService {
  private stripe: InstanceType<typeof Stripe> | null = null;

  getClient(): InstanceType<typeof Stripe> | null {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) return null;
    if (!this.stripe) {
      this.stripe = new Stripe(apiKey, { typescript: true });
    }
    return this.stripe;
  }

  /**
   * Delete the customer, which cancels any subscriptions it holds — used to stop billing on account
   * deletion. No-op when the person never had a customer, or when Stripe is unconfigured (no key);
   * a real Stripe API error propagates so the caller can abort before erasing anything.
   */
  async deleteCustomer(customerId: string | null | undefined): Promise<void> {
    if (!customerId) return;
    const stripe = this.getClient();
    if (!stripe) return;
    await stripe.customers.del(customerId);
  }
}
