/**
 * Personalization brain — the second beat of Onboarding (CONTEXT.md: Onboarding /
 * Personalization). Turns a verified User into a *personalized* one: it validates the
 * chosen Improvement Areas and Interests against the shared controlled vocabularies, writes
 * them (with locale/timezone) to the `User`, and stamps `onboardingCompletedAt` — the signal
 * the bot gates coaching on (ADR-0044).
 *
 * Transport-agnostic, mirroring `onboarding.ts`: it returns a decision and never touches
 * `NextResponse`/`cookies`, so it is unit-tested through the injected `ProfileWriter` seam
 * (prod passes `prisma`; tests pass an in-memory double).
 *
 * Personalization is read-direct profile data: every field is a controlled selection, so
 * there is nothing to crisis-screen, and it is NEVER routed through Mem0/`deriveAndStore` or
 * the screened-record write spine (ADR-0029/0031). Completing it requires at least one valid
 * Improvement Area — an empty profile would give the coach nothing to personalize on.
 */
import { isImprovementArea, isInterest } from '@wabi/shared';

/** Only the slice of the Prisma client this module needs — the seam tests substitute. */
export interface ProfileWriter {
  user: {
    update(args: {
      where: { id: string };
      data: {
        locale: string;
        timezone: string;
        improveAreas: string[];
        interests: string[];
        onboardingCompletedAt: Date;
      };
    }): Promise<{ id: string }>;
  };
}

export type ProfileInput = {
  locale: string;
  timezone: string;
  improveAreas: string[];
  interests: string[];
};

export type CompleteResult = { ok: true } | { ok: 'invalid'; reason: string };

/**
 * The Personalization step's brain. Drops unknown slugs against the controlled vocabularies,
 * requires ≥1 valid Improvement Area (else returns `invalid` and writes nothing), then writes
 * the columns and stamps `onboardingCompletedAt` in one update. Idempotent for the dashboard
 * settings edit; touches no trial/billing fields.
 */
export async function completeOnboarding(
  db: ProfileWriter,
  userId: string,
  input: ProfileInput,
  now: Date,
): Promise<CompleteResult> {
  const improveAreas = input.improveAreas.filter(isImprovementArea);
  const interests = input.interests.filter(isInterest);

  if (improveAreas.length === 0) {
    return { ok: 'invalid', reason: 'at least one improvement area is required' };
  }

  await db.user.update({
    where: { id: userId },
    data: {
      locale: input.locale,
      timezone: input.timezone,
      improveAreas,
      interests,
      onboardingCompletedAt: now,
    },
  });
  return { ok: true };
}
