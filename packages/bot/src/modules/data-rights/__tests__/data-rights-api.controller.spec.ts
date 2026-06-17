// Stub the service module so importing the controller doesn't pull in Mem0/Redis/Prisma deps;
// the controller is exercised against a hand-rolled mock service.
jest.mock('../data-rights.service', () => ({ DataRightsService: class {} }));

import { DataRightsApiController } from '../data-rights-api.controller';

describe('DataRightsApiController', () => {
  it("exports the requested person's data, keyed by discordId", async () => {
    const service = { export: jest.fn().mockResolvedValue('{"moods":[]}') } as any;
    const controller = new DataRightsApiController(service);

    const res = await controller.export({ discordId: 'disc_123' });

    expect(service.export).toHaveBeenCalledWith('disc_123');
    expect(res).toEqual({ data: '{"moods":[]}' });
  });

  it("deletes the requested person's data, keyed by discordId, keeping the account", async () => {
    const service = { delete: jest.fn().mockResolvedValue(undefined) } as any;
    const controller = new DataRightsApiController(service);

    const res = await controller.deleteData({ discordId: 'disc_123' });

    expect(service.delete).toHaveBeenCalledWith('disc_123');
    expect(res).toEqual({ ok: true });
  });

  it('lets a delete failure propagate so the caller learns it was incomplete', async () => {
    const service = {
      delete: jest.fn().mockRejectedValue(new Error('mem0 down')),
    } as any;
    const controller = new DataRightsApiController(service);

    await expect(controller.deleteData({ discordId: 'disc_123' })).rejects.toThrow('mem0 down');
  });

  it('deletes the whole account, keyed by discordId', async () => {
    const service = { deleteAccount: jest.fn().mockResolvedValue(undefined) } as any;
    const controller = new DataRightsApiController(service);

    const res = await controller.deleteAccount({ discordId: 'disc_123' });

    expect(service.deleteAccount).toHaveBeenCalledWith('disc_123');
    expect(res).toEqual({ ok: true });
  });

  it('lets an account-deletion failure propagate (e.g. Stripe down) instead of faking success', async () => {
    const service = {
      deleteAccount: jest.fn().mockRejectedValue(new Error('stripe down')),
    } as any;
    const controller = new DataRightsApiController(service);

    await expect(controller.deleteAccount({ discordId: 'disc_123' })).rejects.toThrow('stripe down');
  });
});
