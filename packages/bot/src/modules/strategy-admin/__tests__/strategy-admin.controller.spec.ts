import { StrategyAdminController } from '../strategy-admin.controller';
import { StrategyAdminService } from '../strategy-admin.service';

describe('StrategyAdminController', () => {
  let controller: StrategyAdminController;
  let service: jest.Mocked<StrategyAdminService>;

  beforeEach(() => {
    service = {
      getPendingDrafts: jest.fn(),
      getPublishedDrafts: jest.fn(),
      approveDraft: jest.fn(),
      rejectDraft: jest.fn(),
      submitDraft: jest.fn(),
      recordNegativeFeedback: jest.fn(),
    } as any;
    controller = new StrategyAdminController(service);
  });

  it('returns pending drafts', async () => {
    service.getPendingDrafts.mockResolvedValue([{ id: '1', title: 'test' }] as any);
    const res = await controller.getPending();
    expect(res).toHaveLength(1);
    expect(service.getPendingDrafts).toHaveBeenCalled();
  });

  it('returns published drafts', async () => {
    service.getPublishedDrafts.mockResolvedValue([{ id: '2', title: 'pub' }] as any);
    const res = await controller.getPublished();
    expect(res).toHaveLength(1);
    expect(service.getPublishedDrafts).toHaveBeenCalled();
  });

  it('approves draft by id', async () => {
    service.approveDraft.mockResolvedValue({ id: '1', status: 'published' } as any);
    const res = await controller.approve('1');
    expect(res?.status).toBe('published');
    expect(service.approveDraft).toHaveBeenCalledWith('1');
  });

  it('rejects draft by id', async () => {
    service.rejectDraft.mockResolvedValue({ id: '1', status: 'quarantined' } as any);
    const res = await controller.reject('1');
    expect(res?.status).toBe('quarantined');
    expect(service.rejectDraft).toHaveBeenCalledWith('1');
  });
});
