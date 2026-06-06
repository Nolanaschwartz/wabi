import { prisma } from '@wabi/shared';
import { lucia } from '@/lib/auth';
import {
  PENDING_CONSENT_COOKIE,
  PENDING_CONSENT_COOKIE_OPTIONS,
  verifyPendingConsentToken,
} from '@/lib/pending-consent';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest): Promise<Response> {
  // Only a valid, signed pending-consent cookie authorizes account creation. There is no
  // pre-existing User/session at this point — this POST is the first write for the identity.
  const pending = verifyPendingConsentToken(
    request.cookies.get(PENDING_CONSENT_COOKIE)?.value,
    Date.now(),
  );
  if (!pending) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = new Date();
  const trialEndsAt = new Date(
    Date.now() + parseInt(process.env.TRIAL_DAYS || '7') * 24 * 60 * 60 * 1000,
  );

  // First-ever persistence for this identity, stamped with consent at the moment of the
  // affirmative action. upsert keeps a retried consent POST (cookie still valid) idempotent.
  const user = await prisma.user.upsert({
    where: { discordId: pending.discordId },
    update: { consentAcceptedAt: now, trialEndsAt, subscriptionStatus: 'trialing' },
    create: {
      discordId: pending.discordId,
      email: pending.email,
      consentAcceptedAt: now,
      trialEndsAt,
      subscriptionStatus: 'trialing',
    },
  });

  const session = await lucia.createSession(user.id, {});
  const sessionCookie = lucia.createSessionCookie(session.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
  // Consume the pending cookie now that the real session exists.
  response.cookies.set(PENDING_CONSENT_COOKIE, '', {
    ...PENDING_CONSENT_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}
