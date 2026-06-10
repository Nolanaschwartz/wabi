import { NextRequest } from 'next/server';
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

  let customerId = dbUser.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { discordId: dbUser.discordId },
    });
    customerId = customer.id;

    const { prisma } = await import('@wabi/shared');
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard?checkout=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard?checkout=canceled`,
    allow_promotion_codes: true,
  });

  return Response.json({ url: session.url });
}
