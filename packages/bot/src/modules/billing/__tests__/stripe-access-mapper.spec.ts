import { mapStripeEvent } from '../stripe-access-mapper';

describe('mapStripeEvent', () => {
  it('maps subscription.created to active access', () => {
    const result = mapStripeEvent({
      type: 'customer.subscription.created',
      data: { customerId: '123', status: 'active' },
    });

    expect(result).toEqual({
      hasActiveAccess: true,
      subscriptionStatus: 'active',
    });
  });

  it('maps subscription.updated with past_due', () => {
    const result = mapStripeEvent({
      type: 'customer.subscription.updated',
      data: { customerId: '123', status: 'past_due' },
    });

    expect(result).toEqual({
      hasActiveAccess: false,
      subscriptionStatus: 'past_due',
    });
  });

  it('maps subscription.deleted to canceled', () => {
    const result = mapStripeEvent({
      type: 'customer.subscription.deleted',
      data: { customerId: '123', status: 'canceled' },
    });

    expect(result).toEqual({
      hasActiveAccess: false,
      subscriptionStatus: 'canceled',
    });
  });

  it('ignores unknown event types', () => {
    const result = mapStripeEvent({
      type: 'unknown.event',
      data: { customerId: '123', status: 'active' },
    });

    expect(result).toBeNull();
  });

  it('is idempotent on duplicate events', () => {
    const event = {
      type: 'customer.subscription.created',
      data: { customerId: '123', status: 'active' as const },
    };

    const r1 = mapStripeEvent(event);
    const r2 = mapStripeEvent(event);
    expect(r1).toEqual(r2);
  });
});
