import { prisma } from '@wabi/shared';
import { requireAuthenticated } from '@/lib/auth-guard';
import { completeOnboarding, type ProfileWriter } from '@/lib/onboarding-profile';

/**
 * Thin adapter over the Personalization brain. Authenticated only; the write is keyed to the
 * session user, so it doubles as the dashboard settings-edit endpoint. All validation (≥1
 * Improvement Area, slug dropping, no billing writes) lives in `completeOnboarding`
 * (onboarding-profile.ts) — this just parses the body and renders the decision.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const result = await completeOnboarding(
    prisma as unknown as ProfileWriter,
    user.id,
    {
      locale: typeof body?.locale === 'string' ? body.locale : 'en-US',
      timezone: typeof body?.timezone === 'string' ? body.timezone : 'UTC',
      improveAreas: asStrings(body?.improveAreas),
      interests: asStrings(body?.interests),
    },
    new Date(),
    // Preserve the original completion time on a settings edit; null on first completion.
    user.onboardingCompletedAt,
  );

  if (result.ok !== true) {
    return new Response(result.reason, { status: 400 });
  }
  return Response.json({ ok: true });
}
