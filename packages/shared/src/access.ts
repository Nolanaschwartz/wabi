/**
 * The subscription lifecycle states, shared so the bot (which maps Stripe webhooks and gates on
 * access) and the web app (which sets the trial state and renders billing) reference ONE enum
 * rather than re-typing the string literals in each package.
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
