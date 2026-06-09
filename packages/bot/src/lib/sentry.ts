import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '@wabi/shared';

export function initSentry(dsn: string): void {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // PII redaction lives in one shared place so bot and web can never drift (ADR-0002/0017).
    beforeSend: (event) => scrubSentryEvent(event),
    tracesSampleRate: 0,
  });
}
