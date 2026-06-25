import { prisma } from '@wabi/shared';
import { establishSession } from '@/lib/session';
import { provisionConsentedUser, type OnboardingWriter } from '@/lib/onboarding';
import {
  PENDING_CONSENT_COOKIE,
  PENDING_CONSENT_COOKIE_OPTIONS,
} from '@/lib/pending-consent';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Thin adapter over the onboarding module. The affirmative consent POST is the first
 * write for a new identity: `provisionConsentedUser` verifies the signed pending-consent
 * token, creates the User, and stamps the Trial (ADR-0011) — returning null (→ 401) and
 * writing nothing if the token is missing/forged/expired. On success we establish the
 * session and consume the pending cookie.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const result = await provisionConsentedUser(
    prisma as unknown as OnboardingWriter,
    request.cookies.get(PENDING_CONSENT_COOKIE)?.value,
    new Date(),
  );
  if (!result) {
    return new Response('Unauthorized', { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  await establishSession(result.userId, response);
  // Consume the pending cookie now that the real session exists.
  response.cookies.set(PENDING_CONSENT_COOKIE, '', {
    ...PENDING_CONSENT_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}
