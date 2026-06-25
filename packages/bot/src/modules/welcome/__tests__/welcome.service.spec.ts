// AccountReads transitively imports @wabi/shared at load; the spec injects a plain mock, so stub it.
jest.mock('@wabi/shared', () => ({}));

import { WelcomeService } from '../welcome.service';

const mockConsentState = jest.fn();

function makeService() {
  const send = jest.fn().mockResolvedValue({});
  const client = { users: { send } } as any;
  const accountReads = { consentState: mockConsentState } as any;
  return { service: new WelcomeService(client, accountReads), send };
}

describe('WelcomeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
  });

  it('sends the welcome opener to a consented user', async () => {
    mockConsentState.mockResolvedValue({ consented: true });
    const { service, send } = makeService();

    await service.welcome('d1');

    expect(send).toHaveBeenCalledTimes(1);
    const [target, payload] = send.mock.calls[0];
    expect(target).toBe('d1');
    expect(payload.content).toContain('Welcome to Wabi');
  });

  it('sends the setup-link message (not the opener) to an unknown user', async () => {
    mockConsentState.mockResolvedValue({ consented: false });
    const { service, send } = makeService();

    await service.welcome('stranger');

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][1];
    expect(payload.content).toContain('/api/auth/discord');
    expect(payload.content).not.toContain('Welcome to Wabi');
  });

  it('sends the setup-link message to a user who has not consented', async () => {
    mockConsentState.mockResolvedValue({ consented: false });
    const { service, send } = makeService();

    await service.welcome('d2');

    const payload = send.mock.calls[0][1];
    expect(payload.content).toContain('/api/auth/discord');
    expect(payload.content).not.toContain('Welcome to Wabi');
  });

  it('swallows DM delivery errors (closed DMs) without throwing', async () => {
    mockConsentState.mockResolvedValue({ consented: true });
    const send = jest.fn().mockRejectedValue(new Error('Cannot send messages to this user'));
    const service = new WelcomeService(
      { users: { send } } as any,
      { consentState: mockConsentState } as any,
    );

    await expect(service.welcome('d3')).resolves.toBeUndefined();
  });

  it('does not enroll the consented user into recurring check-ins (ADR-0008)', async () => {
    mockConsentState.mockResolvedValue({ consented: true });
    const { service } = makeService();

    await service.welcome('d1');

    expect(mockConsentState).toHaveBeenCalled();
  });
});
