import { prisma } from '@wabi/shared';
import { validateRequest } from '@/lib/session';
import { NextResponse } from 'next/server';

export async function POST(): Promise<Response> {
  const { user } = await validateRequest();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const trialEndsAt = new Date(Date.now() + parseInt(process.env.TRIAL_DAYS || '7') * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      consentAcceptedAt: new Date(),
      trialEndsAt,
      subscriptionStatus: 'trialing',
    },
  });

  const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`);
  return response;
}
