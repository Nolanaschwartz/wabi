/**
 * Wabi's Sentry PII-redaction policy, in one place.
 *
 * Wabi handles mental-health-adjacent personal data, so error payloads must never carry user
 * content into Sentry (ADR-0002/0017). This `beforeSend` scrubber is shared by the bot
 * (`@sentry/node`) and the web server and edge runtimes (`@sentry/nextjs`) so the redaction can never drift
 * between them.
 *
 * Deliberately zero-dependency and Prisma-free: the web *edge* runtime imports this via the
 * `@wabi/shared/sentry-scrub` subpath, which must not drag in the Prisma client that the package
 * barrel instantiates at import time.
 */

const REDACTED = '[redacted]';

/** The minimal, SDK-agnostic shape this scrubber touches. Real `@sentry/*` Event types satisfy it. */
export interface SentryEventLike {
  message?: unknown;
  exception?: { values?: Array<{ value?: unknown }> };
  extra?: unknown;
  request?: { data?: unknown };
}

/**
 * Redact every field that can carry user content, mutating and returning the event in place
 * (the contract Sentry's `beforeSend` expects). Generic over the concrete Event type so callers
 * keep their SDK's return type.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  event.message = REDACTED;
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) {
        ex.value = REDACTED;
      }
    }
  }
  if (event.extra) {
    event.extra = {};
  }
  if (event.request) {
    event.request.data = REDACTED;
  }
  return event;
}
