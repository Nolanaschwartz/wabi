import { StripeWebhookController } from '../stripe-webhook.controller';
import { AccessResolver } from '../access-resolver';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
    },
    processedStripeEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  }));
});

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

jest.mock('../access-resolver', () => ({
  AccessResolver: jest.fn().mockImplementation(() => ({
    apply: jest.fn(),
  })),
}));

describe('StripeWebhookController', () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test';
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
  });
  let controller: StripeWebhookController;
  let accessResolver: jest.Mocked<AccessResolver>;

  beforeEach(() => {
    jest.clearAllMocks();
    const { UserService } = require('../../user/user.service');
    accessResolver = new AccessResolver(new UserService()) as any;
    controller = new StripeWebhookController(accessResolver);
  });

  it('does not construct Stripe eagerly and returns 400 when STRIPE_SECRET_KEY is unset', async () => {
    // Boot-safety: an unconfigured bot (no Stripe key) must still start. The controller must
    // not call `new Stripe()` with an empty key at construction (the real library throws).
    delete process.env.STRIPE_SECRET_KEY;
    const Stripe = require('stripe');
    Stripe.mockClear();

    const c = new StripeWebhookController(accessResolver);
    expect(Stripe).not.toHaveBeenCalled();

    const sendMock = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ send: sendMock }) };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await c.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 on missing webhook config', async () => {
    const res = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };
    const req = {
      headers: {},
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 on invalid signature', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found');
    });

    controller = new StripeWebhookController(accessResolver);

    const res = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ignores unknown event types', async () => {
    mockConstructEvent.mockReturnValue({ type: 'invoice.paid', id: 'evt_1' });

    controller = new StripeWebhookController(accessResolver);

    const sendMock = jest.fn();
    const res = {
      status: jest.fn().mockReturnValue({ send: sendMock }),
    };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendMock).toHaveBeenCalledWith('Ignored');
  });

  it('ignores duplicate event redelivery', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.created',
      id: 'evt_1',
      data: { object: { customer: 'cus_123', status: 'active' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue({ id: 'evt_1' });

    const sendMock = jest.fn();
    const res = {
      status: jest.fn().mockReturnValue({ send: sendMock }),
    };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendMock).toHaveBeenCalledWith('Duplicate');
    expect(accessResolver.apply).not.toHaveBeenCalled();
  });

  it('resolves user by stripeCustomerId', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.created',
      id: 'evt_1',
      data: { object: { customer: 'cus_123', status: 'active' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      discordId: 'discord_123',
      stripeCustomerId: 'cus_123',
    });
    (prisma.processedStripeEvent.create as jest.Mock).mockResolvedValue({});
    accessResolver.apply.mockResolvedValue();

    const res = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_123' },
    });
    expect(accessResolver.apply).toHaveBeenCalledWith(
      'discord_123',
      expect.any(Object),
      expect.any(Date),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when user not found by stripeCustomerId', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.created',
      id: 'evt_1',
      data: { object: { customer: 'cus_123', status: 'active' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    const res = {
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
    };
    const req = {
      headers: { 'stripe-signature': 'test' },
      rawBody: Buffer.from('{}'),
    } as any;

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(accessResolver.apply).not.toHaveBeenCalled();
  });

  it('revokes access on customer.subscription.deleted', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      id: 'evt_del',
      created: 200,
      data: { object: { customer: 'cus_123', status: 'canceled' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      discordId: 'discord_123',
      stripeCustomerId: 'cus_123',
      lastStripeEventAt: null,
    });
    accessResolver.apply.mockResolvedValue();

    const sendMock = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ send: sendMock }) };
    const req = { headers: { 'stripe-signature': 'test' }, rawBody: Buffer.from('{}') } as any;

    await controller.handle(req, res);

    expect(accessResolver.apply).toHaveBeenCalledWith(
      'discord_123',
      { hasActiveAccess: false, subscriptionStatus: 'canceled' },
      new Date(200 * 1000),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendMock).toHaveBeenCalledWith('OK');
  });

  it('grants access on an in-order customer.subscription.updated', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      id: 'evt_upd',
      created: 300,
      data: { object: { customer: 'cus_123', status: 'active' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      discordId: 'discord_123',
      stripeCustomerId: 'cus_123',
      lastStripeEventAt: new Date(200 * 1000),
    });
    accessResolver.apply.mockResolvedValue();

    const sendMock = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ send: sendMock }) };
    const req = { headers: { 'stripe-signature': 'test' }, rawBody: Buffer.from('{}') } as any;

    await controller.handle(req, res);

    expect(accessResolver.apply).toHaveBeenCalledWith(
      'discord_123',
      { hasActiveAccess: true, subscriptionStatus: 'active' },
      new Date(300 * 1000),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendMock).toHaveBeenCalledWith('OK');
  });

  it('drops a stale updated arriving after a deleted (out-of-order guard #27)', async () => {
    // A `deleted` was already applied at t=200; a stale `updated` (active) created at t=100
    // is delivered late. It must NOT resurrect access.
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      id: 'evt_stale',
      created: 100,
      data: { object: { customer: 'cus_123', status: 'active' } },
    });

    controller = new StripeWebhookController(accessResolver);
    (prisma.processedStripeEvent.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      discordId: 'discord_123',
      stripeCustomerId: 'cus_123',
      lastStripeEventAt: new Date(200 * 1000),
    });
    (prisma.processedStripeEvent.create as jest.Mock).mockResolvedValue({});

    const sendMock = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ send: sendMock }) };
    const req = { headers: { 'stripe-signature': 'test' }, rawBody: Buffer.from('{}') } as any;

    await controller.handle(req, res);

    expect(accessResolver.apply).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendMock).toHaveBeenCalledWith('Stale');
    // Stale event is still recorded so a redelivery short-circuits at dedup.
    expect(prisma.processedStripeEvent.create).toHaveBeenCalled();
  });
});
