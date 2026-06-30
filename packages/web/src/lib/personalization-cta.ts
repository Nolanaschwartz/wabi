/**
 * The dashboard's Personalization call-to-action decision. Pure so the "nudge while
 * incomplete, edit link when complete" behavior is unit-testable without rendering.
 *
 * The dashboard is never hard-gated on Onboarding (ADR-0011/0004: billing and Data Rights
 * stay always-available) — this only chooses which CTA the dashboard shows.
 */
export type PersonalizationCta = {
  kind: 'finish' | 'edit';
  href: '/onboarding';
  label: string;
};

export function personalizationCta(onboardingComplete: boolean): PersonalizationCta {
  return onboardingComplete
    ? { kind: 'edit', href: '/onboarding', label: 'Edit your personalization' }
    : { kind: 'finish', href: '/onboarding', label: 'Finish personalizing Wabi' };
}
