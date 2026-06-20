import { NextRequest } from 'next/server';
import { prisma } from '@wabi/shared';
import { requireAuthenticated } from '@/lib/auth-guard';
import { getDbUser } from '@/lib/db-user';
import { getStripeClient } from '@/lib/stripe';

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const dbUser = await getDbUser(user.id);
  if (!dbUser) {
    return new Response('User not found', { status: 404 });
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return new Response('Missing STRIPE_PRICE_ID', { status: 500 });
  }

  const stripe = getStripeClient();

  // Create a fresh Stripe customer and persist its id on the user. Used both for first-time
  // checkout and to recover when a stored customer was deleted out-of-band (see retry below).
  const createCustomer = async (): Promise<string> => {
    const customer = await stripe.customers.create({
      metadata: { discordId: dbUser.discordId },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  };

  const createSession = (customer: string) =>
    stripe.checkout.sessions.create({
      customer,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard?checkout=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard?checkout=canceled`,
      allow_promotion_codes: true,
    });

  try {
    let customerId = dbUser.stripeCustomerId ?? (await createCustomer());

    let session;
    try {
      session = await createSession(customerId);
    } catch (err: any) {
      // The stored customer no longer exists in Stripe (e.g. a test-data wipe or a manual
      // dashboard deletion left our DB pointing at a dead id). Recreate it and retry once.
      if (err?.code === 'resource_missing' && err?.param === 'customer') {
        customerId = await createCustomer();
        session = await createSession(customerId);
      } else {
        throw err;
      }
    }

    return Response.json({ url: session.url });
  } catch (err) {
    // Stripe upstream failure (outage, deleted price, test-data wipe, rate limit). Without this the
    // route throws and Next surfaces an opaque 500 with nothing logged — log the cause and return a
    // 502 so the failure is attributable to Stripe rather than our code.
    console.error('[billing/checkout] Stripe request failed', err);
    return new Response('Payment provider unavailable', { status: 502 });
  }
}
