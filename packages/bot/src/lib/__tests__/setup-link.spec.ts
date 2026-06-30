import { setupLinkMessage, finishOnboardingMessage } from '../setup-link';

describe('setupLinkMessage', () => {
  it('builds the finish-setup copy with the Discord auth URL from the base URL', () => {
    const msg = setupLinkMessage('https://wabi.gg');

    expect(msg).toContain('https://wabi.gg/api/auth/discord');
    expect(msg).toContain('finish setup');
  });
});

describe('finishOnboardingMessage', () => {
  it('points the user at the /onboarding page on the base URL', () => {
    const msg = finishOnboardingMessage('https://wabi.gg');

    expect(msg).toContain('https://wabi.gg/onboarding');
  });

  it('does not point at the Discord auth route (that is the unconsented nudge)', () => {
    const msg = finishOnboardingMessage('https://wabi.gg');

    expect(msg).not.toContain('/api/auth/discord');
  });
});
