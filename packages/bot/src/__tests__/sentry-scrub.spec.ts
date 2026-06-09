import { scrubSentryEvent } from '@wabi/shared';

// scrubSentryEvent is the single home of Wabi's Sentry PII-redaction policy (ADR-0002/0017),
// shared by the bot (@sentry/node) and both web runtimes (@sentry/nextjs) so the redaction can
// never drift between them. It tests as a pure function here, per the @wabi/shared convention
// (see provider.spec.ts) since the shared package has no test runner of its own.
describe('scrubSentryEvent', () => {
  it('redacts message, exception values, extra, and request data', () => {
    const event = {
      message: 'User said: I want to kill myself',
      exception: { values: [{ value: 'Error: personal data here' }] },
      extra: { userContent: 'secret' },
      request: { data: 'request body' },
    };

    const result = scrubSentryEvent(event);

    expect(result.message).toBe('[redacted]');
    expect(result.exception.values[0].value).toBe('[redacted]');
    expect(result.extra).toEqual({});
    // The superset field: the bot already scrubbed request.data; folding web onto this scrubber
    // means web now redacts it too (strictly privacy-strengthening).
    expect(result.request.data).toBe('[redacted]');
  });

  it('returns the same event object (mutated in place, as beforeSend expects)', () => {
    const event = { message: 'x' };
    expect(scrubSentryEvent(event)).toBe(event);
  });

  it('tolerates absent exception / extra / request', () => {
    const result = scrubSentryEvent({ message: 'test' });
    expect(result.message).toBe('[redacted]');
  });
});
