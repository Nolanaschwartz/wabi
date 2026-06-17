import { ConflictException } from '@nestjs/common';
import { StrategyAdminController } from '../strategy-admin.controller';
import { StrategyAdminService } from '../strategy-admin.service';

jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue('job_1'),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@qdrant/qdrant-js', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@wabi/shared', () => ({
  prisma: {},
  getProvider: jest.fn().mockReturnValue({ baseUrl: '', model: '', apiKey: '' }),
}));

describe('StrategyAdminController', () => {
  let controller: StrategyAdminController;
  let service: jest.Mocked<StrategyAdminService>;

  beforeEach(() => {
    service = {
      getPendingDrafts: jest.fn(),
      getPublishedDrafts: jest.fn(),
      approveDraft: jest.fn(),
      rejectDraft: jest.fn(),
      removePublished: jest.fn(),
      submitDraft: jest.fn(),
      recordNegativeFeedback: jest.fn(),
      setEvidenceLevel: jest.fn(),
      ingestCandidate: jest.fn(),
      hasSeen: jest.fn(),
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

  it('removes a published draft by id', async () => {
    service.removePublished.mockResolvedValue({ id: '1', status: 'quarantined' } as any);
    const res = await controller.remove('1');
    expect(res?.status).toBe('quarantined');
    expect(service.removePublished).toHaveBeenCalledWith('1');
  });

  it('adjusts evidence level by id', async () => {
    service.setEvidenceLevel.mockResolvedValue({ id: '1', evidence: 'RCT meta-analysis' } as any);
    const res = await controller.setEvidence('1', 'RCT meta-analysis');
    expect(res?.evidence).toBe('RCT meta-analysis');
    expect(service.setEvidenceLevel).toHaveBeenCalledWith('1', 'RCT meta-analysis');
  });

  it('ingests a novel candidate and returns the draft id', async () => {
    service.ingestCandidate.mockResolvedValue({ status: 'submitted', draftId: 'd1' });
    const res = await controller.ingest({ sourceId: 'PMID:1' } as any);
    expect(res).toEqual({ status: 'submitted', draftId: 'd1' });
  });
  it('maps a deduped candidate to 409 Conflict', async () => {
    service.ingestCandidate.mockResolvedValue({ status: 'deduped' });
    await expect(controller.ingest({ sourceId: 'PMID:1' } as any)).rejects.toBeInstanceOf(ConflictException);
  });
  it('reports seen status', async () => {
    service.hasSeen.mockResolvedValue(true);
    expect(await controller.seen('PMID:1')).toEqual({ seen: true });
    expect(service.hasSeen).toHaveBeenCalledWith('PMID:1');
  });
});
