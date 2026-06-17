/**
 * The subscription lifecycle states, shared so the bot (which maps Stripe webhooks and gates on
 * access) and the web app (which sets the trial state and renders billing) reference ONE type
 * rather than re-typing the string literals in each package.
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export interface AccessState {
  /** Used for runtime gating only — never persisted. */
  hasActiveAccess: boolean;
  subscriptionStatus: SubscriptionStatus;
}

/** ~7-day Trial, the only no-cost path (ADR-0011). Overridable via TRIAL_DAYS. */
const DEFAULT_TRIAL_DAYS = 7;

/**
 * The single Active Access decision (ADR-0005/0011), shared so the bot's coaching gate and the web
 * dashboard agree by construction. Pure — given the user's billing fields and the current time it
 * returns the access state, with no I/O. Each caller passes a row it already loaded.
 *
 * Formula: access = (status === 'active') OR (status === 'trialing' AND trialEndsAt > now).
 * A `trialing` status alone does NOT grant access once the Trial date has passed: a web Trial has no
 * Stripe subscription, so no webhook ever moves it off 'trialing' — access must therefore expire on
 * the date, not on a status change. `past_due` and `canceled` are never active.
 */
export function decideAccess(
  user: { trialEndsAt: Date | null; subscriptionStatus: string } | null,
  now: Date,
): AccessState {
  if (!user) {
    return { hasActiveAccess: false, subscriptionStatus: 'canceled' };
  }

  const status = user.subscriptionStatus as SubscriptionStatus;
  const subscribed = status === 'active';
  const trialActive =
    status === 'trialing' && user.trialEndsAt != null && user.trialEndsAt > now;

  return {
    hasActiveAccess: subscribed || trialActive,
    subscriptionStatus: status,
  };
}

/**
 * The Trial grant (ADR-0011/0015): the initial access state stamped on a new User at web onboarding.
 * Pure and shared so the web consent route and any other writer compute the same window. Reads
 * TRIAL_DAYS lazily (call time, never import time) per the project's config rule.
 */
export function trialGrant(now: Date): {
  trialEndsAt: Date;
  subscriptionStatus: SubscriptionStatus;
} {
  const days = Number(process.env.TRIAL_DAYS ?? DEFAULT_TRIAL_DAYS);
  return {
    trialEndsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
    subscriptionStatus: 'trialing',
  };
}
