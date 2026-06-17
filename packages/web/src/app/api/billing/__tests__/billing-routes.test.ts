import { POST as checkoutPost } from '../checkout/route';
import { POST as portalPost } from '../portal/route';

const mockStripe = {
  customers: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
};

jest.mock('@/lib/session', () => ({
  validateRequest: jest.fn(),
}));

jest.mock('stripe', () => jest.fn(() => mockStripe));

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const { validateRequest } = require('@/lib/session');
const { prisma } = require('@wabi/shared');

describe('Billing routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    process.env.STRIPE_PRICE_ID = 'price_test123';
    process.env.STRIPE_SECRET_KEY = 'sk_test';
  });

  describe('checkout', () => {
    it('returns 401 when not authenticated', async () => {
      validateRequest.mockResolvedValue({ user: null, session: null });
      const res = await checkoutPost({} as any);
      expect(res.status).toBe(401);
    });

    it('creates customer and subscription, redirects to checkout', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        discordId: '123',
        stripeCustomerId: null,
      });
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/test',
      });

      const res = await checkoutPost({} as any);
      const data = await res.json();

      expect(data.url).toBe('https://checkout.stripe.com/test');
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { discordId: '123' } }),
      );
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_test123', quantity: 1 }],
        }),
      );
    });

    it('reuses existing stripeCustomerId', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        discordId: '123',
        stripeCustomerId: 'cus_existing',
      });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/test',
      });

      const res = await checkoutPost({} as any);
      await res.json();

      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' }),
      );
    });

    it('recreates the customer and retries when the stored customer was deleted', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        discordId: '123',
        stripeCustomerId: 'cus_deleted',
      });

      const missing = Object.assign(new Error("No such customer: 'cus_deleted'"), {
        code: 'resource_missing',
        param: 'customer',
      });
      mockStripe.checkout.sessions.create
        .mockRejectedValueOnce(missing)
        .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/retry' });
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_fresh' });

      const res = await checkoutPost({} as any);
      const data = await res.json();

      expect(data.url).toBe('https://checkout.stripe.com/retry');
      expect(mockStripe.customers.create).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { stripeCustomerId: 'cus_fresh' } }),
      );
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
      expect(mockStripe.checkout.sessions.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ customer: 'cus_fresh' }),
      );
    });

    it('returns 502 (not an opaque throw) when Stripe fails', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        discordId: '123',
        stripeCustomerId: 'cus_existing',
      });
      mockStripe.checkout.sessions.create.mockRejectedValue(
        new Error('Your test data is in the process of being deleted.'),
      );

      const res = await checkoutPost({} as any);

      expect(res.status).toBe(502);
    });
  });

  describe('portal', () => {
    it('returns 401 when not authenticated', async () => {
      validateRequest.mockResolvedValue({ user: null, session: null });
      const res = await portalPost();
      expect(res.status).toBe(401);
    });

    it('returns 400 when no stripeCustomerId', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        stripeCustomerId: null,
      });
      const res = await portalPost();
      expect(res.status).toBe(400);
    });

    it('creates billing portal session', async () => {
      validateRequest.mockResolvedValue({ user: { id: 'u1' }, session: {} as any });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://billing.stripe.com/test',
      });

      const res = await portalPost();
      const data = await res.json();

      expect(data.url).toBe('https://billing.stripe.com/test');
    });
  });
});
