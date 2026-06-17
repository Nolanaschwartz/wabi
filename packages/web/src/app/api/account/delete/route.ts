import { NextRequest, NextResponse } from 'next/server';
import { lucia } from '@/lib/auth';
import { requireAuthenticated } from '@/lib/auth-guard';
import { callDataRightsApi } from '@/lib/data-rights-api';

/**
 * Delete the signed-in person's whole account. Authenticates the lucia session and forwards their
 * own discordId to the bot's `DataRightsService.deleteAccount()` (cancels Stripe, hard-deletes the
 * User row — cascading the session rows — and purges all data). Only on success do we invalidate
 * the lucia session and clear the cookie, so a failed/partial deletion never logs the person out
 * while their account still (partly) exists. The client redirects to the goodbye page afterward.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const res = await callDataRightsApi('delete', user.discordId);
  if (!res.ok) {
    return new Response('Failed to delete account', { status: res.status });
  }

  const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
  if (sessionId) {
    await lucia.invalidateSession(sessionId);
  }

  const blank = lucia.createBlankSessionCookie();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(blank.name, blank.value, blank.attributes);
  return response;
}
