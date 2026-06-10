import { getDbUser } from '@/lib/db-user';
import { requireAuthenticated } from '@/lib/auth-guard';
import { getStripeClient } from '@/lib/stripe';

export async function POST(): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const dbUser = await getDbUser(user.id);
  if (!dbUser?.stripeCustomerId) {
    return new Response('No subscription on file', { status: 400 });
  }

  const stripe = getStripeClient();

  const portal = await stripe.billingPortal.sessions.create({
    customer: dbUser.stripeCustomerId,
    return_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`,
  });

  return Response.json({ url: portal.url });
}
