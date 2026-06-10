import Stripe from 'stripe';

let instance: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!instance) {
    instance = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      apiVersion: '2026-05-27.dahlia',
    });
  }
  return instance;
}
