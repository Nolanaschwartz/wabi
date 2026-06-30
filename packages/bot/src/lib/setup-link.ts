/**
 * The single source of the "finish setup" prompt. Both the unconsented-DM coaching path
 * and the welcome-on-join path send this so the two can never drift apart.
 *
 * Onboarding entry point: the OAuth route starts Discord login → explicit consent → dashboard.
 */
export function setupLinkMessage(baseUrl: string): string {
  const setupUrl = `${baseUrl}/api/auth/discord`;
  return `You'll need to finish setup before we can chat. Click here to get started: ${setupUrl}`;
}

/**
 * The consent-tier nudge for a consented user who never finished web Onboarding (ADR-0044). A sibling
 * of {@link setupLinkMessage}: same "finish setup on the web app" stance, but the person already has a
 * row + Trial, so it points at the Personalization step (`/onboarding`) rather than the OAuth entry.
 * The bot withholds coaching until `onboardingCompletedAt` is set; the always-on crisis tripwire still
 * runs upstream of this (EchoController), so the safety floor is never gated by Onboarding.
 */
export function finishOnboardingMessage(baseUrl: string): string {
  const onboardingUrl = `${baseUrl}/onboarding`;
  return `Almost there — finish personalizing Wabi so I can coach you well: ${onboardingUrl}`;
}
