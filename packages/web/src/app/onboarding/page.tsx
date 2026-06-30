import { redirect } from 'next/navigation';
import { validateRequest } from '@/lib/session';
import OnboardingForm from './onboarding-form';

/**
 * The Personalization step — the second beat of Onboarding (CONTEXT.md: Onboarding /
 * Personalization). Reached after consent (the accept handler routes here) and from the
 * dashboard "edit your personalization" link, so it doubles as the settings editor: an
 * already-onboarded user may open it directly and it is prefilled from their row.
 *
 * Personalization is collected as controlled selections only — no free text, nothing to
 * crisis-screen. The form posts to /api/onboarding, which writes the columns and stamps
 * onboardingCompletedAt; the bot gates coaching on that stamp (ADR-0044).
 */
export default async function OnboardingPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect('/api/auth/discord');
  }

  return (
    <OnboardingForm
      initial={{
        locale: user.locale,
        timezone: user.timezone,
        improveAreas: user.improveAreas,
        interests: user.interests,
      }}
      // An already-onboarded visitor is editing; a fresh one is finishing setup.
      isEdit={user.onboardingCompletedAt !== null}
    />
  );
}
