import type { SubscriptionStatus } from '@wabi/shared';

export type { SubscriptionStatus };

export interface AccessState {
  /** Derived (decideAccess) — used for runtime gating, never persisted. */
  hasActiveAccess: boolean;
  subscriptionStatus: SubscriptionStatus;
}

export class StripeAccessMapper {
  static map(event: StripeWebhookEvent): AccessState | null {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return {
          hasActiveAccess:
            event.data.status === 'active' || event.data.status === 'trialing',
          subscriptionStatus:
            event.data.status === 'past_due'
              ? 'past_due'
              : event.data.status === 'active'
                ? 'active'
                : 'trialing',
        };
      case 'customer.subscription.deleted':
        return {
          hasActiveAccess: false,
          subscriptionStatus: 'canceled',
        };
      default:
        return null;
    }
  }
}

export interface StripeWebhookEvent {
  id?: string;
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted'
    | string;
  data: {
    customerId: string;
    status: 'active' | 'trialing' | 'past_due' | 'canceled';
  };
}
