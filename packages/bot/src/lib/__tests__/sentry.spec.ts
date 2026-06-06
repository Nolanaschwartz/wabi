import * as Sentry from '@sentry/node';
import { initSentry } from '../sentry';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
}));

describe('initSentry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scrubs message content in beforeSend', () => {
    initSentry('https://test@sentry.io/123');

    const beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
    const event = {
      message: 'User said: I want to kill myself',
      exception: {
        values: [
          { value: 'Error: personal data here' },
        ],
      },
      extra: { userContent: 'secret' },
      request: { data: 'request body' },
    };

    const result = beforeSend(event);
    expect(result.message).toBe('[redacted]');
    expect(result.exception.values[0].value).toBe('[redacted]');
    expect(result.extra).toEqual({});
    expect(result.request.data).toBe('[redacted]');
  });

  it('handles missing exception values', () => {
    initSentry('https://test@sentry.io/123');

    const beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
    const event = { message: 'test' };

    const result = beforeSend(event);
    expect(result.message).toBe('[redacted]');
  });

  it('sets tracesSampleRate to 0', () => {
    initSentry('https://test@sentry.io/123');

    const config = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(config.tracesSampleRate).toBe(0);
  });
});
