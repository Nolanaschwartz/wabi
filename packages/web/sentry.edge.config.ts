import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'http://localhost:8000/1',
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend: (event) => {
    event.message = '[redacted]';
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) {
          ex.value = '[redacted]';
        }
      }
    }
    if (event.extra) {
      event.extra = {};
    }
    return event;
  },
  tracesSampleRate: 0,
});
