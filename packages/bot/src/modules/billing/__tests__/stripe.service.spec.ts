const mockCustomers = { del: jest.fn() };
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ customers: mockCustomers })),
);

import { StripeService } from '../stripe.service';

describe('StripeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('deletes the Stripe customer (which cancels its subscriptions) when configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    const svc = new StripeService();

    await svc.deleteCustomer('cus_123');

    expect(mockCustomers.del).toHaveBeenCalledWith('cus_123');
  });

  it('is a no-op when the person has no Stripe customer on file', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    const svc = new StripeService();

    await svc.deleteCustomer(null);

    expect(mockCustomers.del).not.toHaveBeenCalled();
  });

  it('is a no-op when Stripe is unconfigured (no secret key)', async () => {
    const svc = new StripeService();

    await svc.deleteCustomer('cus_123');

    expect(mockCustomers.del).not.toHaveBeenCalled();
  });

  it('propagates a Stripe API failure so the caller can abort', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    mockCustomers.del.mockRejectedValueOnce(new Error('stripe down'));
    const svc = new StripeService();

    await expect(svc.deleteCustomer('cus_123')).rejects.toThrow('stripe down');
  });
});
