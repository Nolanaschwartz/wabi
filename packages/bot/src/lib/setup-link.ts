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
