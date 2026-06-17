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
});
