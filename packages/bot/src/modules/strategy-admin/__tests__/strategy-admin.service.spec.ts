import { StrategyAdminService } from '../strategy-admin.service';
import { StrategyTrustGate } from '../strategy-trust-gate';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    strategyDraft: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Mocking the Scheduler also keeps pg-boss (ESM) out of the import graph.
jest.mock('../../scheduler/scheduler.service', () => ({
  SchedulerService: jest.fn(),
}));

jest.mock('@qdrant/qdrant-js', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../strategy-trust-gate', () => ({
  StrategyTrustGate: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn(),
    shouldQuarantine: jest.fn(),
  })),
}));

describe('StrategyAdminService', () => {
  let service: StrategyAdminService;
  let trustGate: jest.Mocked<StrategyTrustGate>;
  let retrieval: jest.Mocked<StrategyRetrievalService>;
  // Plain scheduler stub; `available` is flipped per-test to exercise durable vs synchronous demote.
  let scheduler: { work: jest.Mock; send: jest.Mock; available: boolean };

  beforeEach(() => {
    jest.clearAllMocks();
    trustGate = new StrategyTrustGate() as any;
    retrieval = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;
    scheduler = {
      work: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue('job_1'),
      available: true,
    };
    service = new StrategyAdminService(trustGate, retrieval, scheduler as any);
  });

  it('publishes draft when decision is publish', async () => {
    trustGate.evaluate.mockResolvedValue({
      decision: 'publish',
      reason: 'auto-published',
    });
    (prisma.strategyDraft.create as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceText: null,
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'allowlisted',
      status: 'published',
      negativeCount: 0,
    });

    const result = await service.submitDraft({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'allowlisted',
      status: 'draft',
    });

    expect(result.status).toBe('published');
    expect(prisma.strategyDraft.create).toHaveBeenCalled();
    expect(retrieval.upsert).toHaveBeenCalledWith(
      '1',
      expect.stringContaining('Test technique'),
      'Test evidence',
    );
  });

  it('queues draft when decision is queue', async () => {
    trustGate.evaluate.mockResolvedValue({
      decision: 'queue',
      reason: 'queued',
    });
    (prisma.strategyDraft.create as jest.Mock).mockResolvedValue({
      id: '2',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test',
      evidence: 'Test evidence',
      sourceText: null,
      sourceUrl: 'https://example.com',
      trustLevel: 'session-mined',
      status: 'pending-review',
      negativeCount: 0,
    });

    const result = await service.submitDraft({
      id: '2',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test',
      evidence: 'Test evidence',
      sourceUrl: 'https://example.com',
      trustLevel: 'session-mined',
      status: 'draft',
    });

    expect(result.status).toBe('pending-review');
    expect(retrieval.upsert).not.toHaveBeenCalled();
  });

  it('persists draft in Postgres and survives restart', async () => {
    trustGate.evaluate.mockResolvedValue({
      decision: 'queue',
      reason: 'queued',
    });
    (prisma.strategyDraft.create as jest.Mock).mockResolvedValue({
      id: '3',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test',
      evidence: 'Test evidence',
      sourceText: 'Source text here',
      sourceUrl: 'https://example.com',
      trustLevel: 'community',
      status: 'pending-review',
      negativeCount: 0,
    });

    await service.submitDraft({
      id: '3',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test',
      evidence: 'Test evidence',
      sourceText: 'Source text here',
      sourceUrl: 'https://example.com',
      trustLevel: 'community',
      status: 'draft',
    });

    expect(prisma.strategyDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceText: 'Source text here',
        }),
      }),
    );
  });

  it('returns pending drafts from Postgres', async () => {
    (prisma.strategyDraft.findMany as jest.Mock).mockResolvedValue([
      {
        id: '1',
        title: 'Pending Draft',
        technique: 'Test',
        source: 'Test',
        evidence: 'Test',
        sourceText: null,
        sourceUrl: 'https://test.com',
        trustLevel: 'community',
        status: 'pending-review',
        negativeCount: 0,
      },
    ]);

    const pending = await service.getPendingDrafts();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending-review');
  });

  it('approves draft', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test',
      source: 'Test',
      evidence: 'Test',
      sourceText: null,
      sourceUrl: 'https://test.com',
      trustLevel: 'community',
      status: 'published',
      negativeCount: 0,
    });

    const result = await service.approveDraft('1');
    expect(result?.status).toBe('published');
    expect(retrieval.upsert).toHaveBeenCalledWith('1', expect.any(String), 'Test');
  });

  it('rejects draft', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test',
      source: 'Test',
      evidence: 'Test',
      sourceText: null,
      sourceUrl: 'https://test.com',
      trustLevel: 'community',
      status: 'quarantined',
      negativeCount: 0,
    });

    const result = await service.rejectDraft('1');
    expect(result?.status).toBe('quarantined');
    expect(retrieval.delete).toHaveBeenCalledWith('1');
  });

  it('adjusts evidence level and persists the change', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test',
      source: 'Test',
      evidence: 'RCT meta-analysis',
      sourceText: null,
      sourceUrl: 'https://test.com',
      trustLevel: 'community',
      status: 'pending-review',
      negativeCount: 0,
    });

    const result = await service.setEvidenceLevel('1', 'RCT meta-analysis');

    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { evidence: 'RCT meta-analysis' },
    });
    expect(result?.evidence).toBe('RCT meta-analysis');
  });

  it('returns null when adjusting evidence on a non-existent draft', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockRejectedValue(new Error('not found'));
    const result = await service.setEvidenceLevel('999', 'whatever');
    expect(result).toBeNull();
  });

  it('returns null for non-existent draft approval', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockRejectedValue(new Error('not found'));
    const result = await service.approveDraft('999');
    expect(result).toBeNull();
  });

  it('auto-quarantines at threshold synchronously when no durable queue is available', async () => {
    scheduler.available = false;
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'published',
      negativeCount: 2,
    });
    (trustGate.shouldQuarantine as jest.Mock).mockReturnValue(true);
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({});

    await service.recordNegativeFeedback('1');

    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { status: 'quarantined', negativeCount: 0 },
    });
    expect(retrieval.delete).toHaveBeenCalledWith('1');
  });

  it('enqueues a durable demote job at threshold when the queue is available', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'published',
      negativeCount: 2,
    });
    (trustGate.shouldQuarantine as jest.Mock).mockReturnValue(true);
    // scheduler.available defaults to true → durable enqueue path.

    await service.recordNegativeFeedback('1');

    expect(scheduler.send).toHaveBeenCalledWith('strategy-demote', { draftId: '1' });
    // Demotion is deferred to the worker — no synchronous quarantine write.
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
    expect(retrieval.delete).not.toHaveBeenCalled();
  });

  it('applyDemote quarantines in Postgres and removes from Qdrant', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({});

    await service.applyDemote('1');

    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { status: 'quarantined', negativeCount: 0 },
    });
    expect(retrieval.delete).toHaveBeenCalledWith('1');
  });

  it('increments negative count below threshold', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'published',
      negativeCount: 1,
    });
    (trustGate.shouldQuarantine as jest.Mock).mockReturnValue(false);
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({});

    await service.recordNegativeFeedback('1');

    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { negativeCount: 2 },
    });
  });

  it('does nothing for non-published draft feedback', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'pending-review',
      negativeCount: 0,
    });

    await service.recordNegativeFeedback('1');
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });

  it('does nothing for non-existent draft feedback', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue(null);
    await service.recordNegativeFeedback('999');
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });
});
