import {
  PENDING_CONSENT_COOKIE,
  PENDING_CONSENT_COOKIE_OPTIONS,
} from '@/lib/pending-consent';
import { NextResponse } from 'next/server';

export async function POST(): Promise<Response> {
  // Nothing is persisted before consent (issue #29), so declining only drops the pending
  // identity cookie. No User/Trial exists to delete — abandoning the page is equivalent.
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PENDING_CONSENT_COOKIE, '', {
    ...PENDING_CONSENT_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}
