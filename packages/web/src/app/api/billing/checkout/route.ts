import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { validateRequest } from '@/lib/session';

export async function POST(req: NextRequest): Promise<Response> {
  const { user } = await validateRequest();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { prisma } = await import('@wabi/shared');
  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser) {
    return new Response('User not found', { status: 404 });
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return new Response('Missing STRIPE_PRICE_ID', { status: 500 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
    apiVersion: '2026-05-27.dahlia',
  });

  let customerId = dbUser.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { discordId: dbUser.discordId },
    });
    customerId = customer.id;

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
