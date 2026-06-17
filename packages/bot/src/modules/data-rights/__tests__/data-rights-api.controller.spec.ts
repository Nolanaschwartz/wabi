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
});
