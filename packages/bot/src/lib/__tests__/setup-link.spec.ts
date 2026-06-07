import { setupLinkMessage } from '../setup-link';

describe('setupLinkMessage', () => {
  it('builds the finish-setup copy with the Discord auth URL from the base URL', () => {
    const msg = setupLinkMessage('https://wabi.gg');

    expect(msg).toContain('https://wabi.gg/api/auth/discord');
    expect(msg).toContain('finish setup');
  });
});
