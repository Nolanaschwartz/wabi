import * as Sentry from '@sentry/node';

export function initSentry(dsn: string): void {
  Sentry.init({
    dsn,
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
      if (event.request) {
        event.request.data = '[redacted]';
      }
      return event;
    },
    tracesSampleRate: 0,
  });
}
