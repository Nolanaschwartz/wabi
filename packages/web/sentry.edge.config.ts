import * as Sentry from '@sentry/nextjs';
// Edge runtime: import the redaction via the Prisma-free subpath, NOT the @wabi/shared barrel
// (which instantiates PrismaClient at import and would break the edge bundle). ADR-0002/0017.
import { scrubSentryEvent } from '@wabi/shared/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'http://localhost:8000/1',
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend: (event) => scrubSentryEvent(event),
  tracesSampleRate: 0,
});
