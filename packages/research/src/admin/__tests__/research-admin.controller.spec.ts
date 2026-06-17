import { ConflictException } from '@nestjs/common';
import { ResearchAdminController } from '../research-admin.controller';
import { ResearchConfigService } from '../../config-service/research-config.service';

describe('ResearchAdminController', () => {
  it('GET config delegates to ResearchConfigService.getConfig', async () => {
    const payload = { config: { id: 'singleton' }, topics: [{ id: 't1' }] };
    const service = { getConfig: jest.fn().mockResolvedValue(payload) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service);

    await expect(controller.getConfig()).resolves.toEqual(payload);
    expect(service.getConfig).toHaveBeenCalledTimes(1);
  });

  it('POST topics delegates to createTopic', async () => {
    const created = { id: 't9', text: 'sleep', enabled: true };
    const service = { createTopic: jest.fn().mockResolvedValue(created) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service);

    await expect(controller.createTopic({ text: 'sleep' })).resolves.toEqual(created);
    expect(service.createTopic).toHaveBeenCalledWith('sleep');
  });

  it('POST topics surfaces a ConflictException for duplicate text (→ 409)', async () => {
    const service = {
      createTopic: jest.fn().mockRejectedValue(new ConflictException({ status: 'duplicate' })),
    } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service);

    await expect(controller.createTopic({ text: 'dup' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('PATCH topics/:id delegates to updateTopic', async () => {
    const updated = { id: 't1', text: 'a', enabled: false };
    const service = { updateTopic: jest.fn().mockResolvedValue(updated) } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service);

    await expect(controller.updateTopic('t1', { enabled: false })).resolves.toEqual(updated);
    expect(service.updateTopic).toHaveBeenCalledWith('t1', { enabled: false });
  });

  it('DELETE topics/:id delegates to deleteTopic', async () => {
    const service = {
      deleteTopic: jest.fn().mockResolvedValue({ id: 't1', text: 'a', enabled: true }),
    } as unknown as ResearchConfigService;
    const controller = new ResearchAdminController(service);

    await expect(controller.deleteTopic('t1')).resolves.toEqual({ id: 't1', text: 'a', enabled: true });
    expect(service.deleteTopic).toHaveBeenCalledWith('t1');
  });
});
