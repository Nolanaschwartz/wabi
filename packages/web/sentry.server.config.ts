import * as Sentry from '@sentry/nextjs';
// Prisma-free subpath: the same redaction the bot uses, so the policy can't drift (ADR-0002/0017).
import { scrubSentryEvent } from '@wabi/shared/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'http://localhost:8000/1',
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend: (event) => scrubSentryEvent(event),
  tracesSampleRate: 0,
});
