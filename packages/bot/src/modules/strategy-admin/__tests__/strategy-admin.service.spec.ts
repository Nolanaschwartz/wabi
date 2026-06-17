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
    processedSource: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
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
  let scheduler: { work: jest.Mock; cron: jest.Mock; send: jest.Mock; available: boolean };

  beforeEach(() => {
    jest.clearAllMocks();
    trustGate = new StrategyTrustGate() as any;
    retrieval = {
      upsert: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(true),
    } as any;
    scheduler = {
      work: jest.fn().mockResolvedValue(undefined),
      cron: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue('job_1'),
      available: true,
    };
    service = new StrategyAdminService(trustGate, retrieval, scheduler as any, {
      declare: jest.fn(),
    } as any);
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

  it('approves a pending-review draft (indexing first, then marking published)', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test',
      evidence: 'Test',
      status: 'pending-review',
    });
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

  it('does NOT mark a draft published if the index upsert fails (published => retrievable)', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      title: 'Test',
      technique: 'Test',
      evidence: 'Test',
      status: 'pending-review',
    });
    (retrieval.upsert as jest.Mock).mockResolvedValue(false);

    const result = await service.approveDraft('1');

    expect(result).toBeNull();
    // The status was never flipped to published — it stays pending-review for retry.
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });

  it('reconcile re-asserts the index from Postgres: re-indexes published, removes quarantined', async () => {
    (prisma.strategyDraft.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: 'p1', title: 'A', technique: 'a', evidence: 'e' }]) // published
      .mockResolvedValueOnce([{ id: 'q1' }]); // quarantined

    const result = await service.reconcile();

    expect(retrieval.upsert).toHaveBeenCalledWith('p1', expect.any(String), 'e');
    expect(retrieval.delete).toHaveBeenCalledWith('q1');
    expect(result).toEqual({ reindexed: 1, removed: 1 });
  });

  it('rejects a pending-review draft', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'pending-review',
    });
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

  it('refuses to re-publish a draft that is not pending-review (lifecycle guard)', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'quarantined',
    });

    const result = await service.approveDraft('1');

    expect(result).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
    expect(retrieval.upsert).not.toHaveBeenCalled();
  });

  it('refuses to reject a draft that is not pending-review (lifecycle guard)', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'published',
    });

    const result = await service.rejectDraft('1');

    expect(result).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
    expect(retrieval.delete).not.toHaveBeenCalled();
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

  it('removePublished quarantines a published draft and removes it from the index', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'published',
    });
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

    const result = await service.removePublished('1');

    expect(result?.status).toBe('quarantined');
    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { status: 'quarantined' },
    });
    expect(retrieval.delete).toHaveBeenCalledWith('1');
  });

  it('refuses to remove a draft that is not published (lifecycle guard)', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({
      id: '1',
      status: 'pending-review',
    });

    const result = await service.removePublished('1');

    expect(result).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
    expect(retrieval.delete).not.toHaveBeenCalled();
  });

  it('returns null when removing a non-existent draft', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await service.removePublished('999');

    expect(result).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
    expect(retrieval.delete).not.toHaveBeenCalled();
  });
});

describe('StrategyAdminService.isDuplicate', () => {
  let svc: StrategyAdminService;
  let retrieval: { search: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';
    retrieval = { search: jest.fn() };
    svc = new StrategyAdminService({} as any, retrieval as any, {} as any, {} as any);
  });

  it('is a duplicate when the top match scores at/above threshold', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: 'x', evidence: 'y', score: 0.97 }]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(true);
    expect(retrieval.search).toHaveBeenCalledWith('PMR: tense and release', 1);
  });
  it('is not a duplicate below threshold', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: 'x', evidence: 'y', score: 0.4 }]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(false);
  });
  it('is not a duplicate when the library is empty', async () => {
    retrieval.search.mockResolvedValue([]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(false);
  });
});

describe('StrategyAdminService ledger', () => {
  const svc = new StrategyAdminService({} as any, { search: jest.fn() } as any, {} as any, {} as any);
  beforeEach(() => jest.clearAllMocks());

  it('hasSeen returns true when a row exists', async () => {
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue({ sourceId: 'PMID:1' });
    expect(await svc.hasSeen('PMID:1')).toBe(true);
  });
  it('hasSeen returns false when absent', async () => {
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await svc.hasSeen('PMID:9')).toBe(false);
  });
  it('markProcessed upserts the ledger row', async () => {
    await svc.markProcessed('PMID:1', 'pubmed', 'submitted');
    expect(prisma.processedSource.upsert).toHaveBeenCalledWith({
      where: { sourceId: 'PMID:1' },
      create: { sourceId: 'PMID:1', source: 'pubmed', lastStatus: 'submitted' },
      update: { lastStatus: 'submitted' },
    });
  });
});

describe('StrategyAdminService.ingestCandidate', () => {
  let svc: StrategyAdminService;
  let trustGate: { evaluate: jest.Mock };
  let retrieval: { search: jest.Mock };

  const candidate = {
    title: 'PMR', technique: 'tense and release', source: 'PubMed',
    evidence: 'peer-reviewed: RCT', sourceText: 'progressive muscle relaxation reduced anxiety',
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345',
    sourceId: 'PMID:12345', sourceKind: 'pubmed',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';
    trustGate = { evaluate: jest.fn() };
    retrieval = { search: jest.fn() };
    svc = new StrategyAdminService(trustGate as any, retrieval as any, {} as any, {} as any);
    jest.spyOn(svc, 'markProcessed').mockResolvedValue();
    // Default: source not yet in the ledger, so each test reaches the normal ingest path.
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it('short-circuits as deduped when the source is already in the ledger, without re-evaluating or re-marking', async () => {
    // Bot-side idempotency on the authoritative sourceId key (ProcessedSource.sourceId @id): a paper
    // already processed on a prior run must never be re-evaluated or re-submitted, even if the worker
    // failed to filter it. Would otherwise pass (search [] -> queue -> submitted).
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue({ sourceId: 'PMID:12345' });
    retrieval.search.mockResolvedValue([]);
    trustGate.evaluate.mockResolvedValue({ decision: 'queue', reason: 'ok' });
    const res = await svc.ingestCandidate(candidate as any);
    expect(res.status).toBe('deduped');
    expect(trustGate.evaluate).not.toHaveBeenCalled();
    expect(svc.markProcessed).not.toHaveBeenCalled(); // preserve the original terminal lastStatus
  });

  it('returns deduped and records the ledger when a near-duplicate exists', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: '', evidence: '', score: 0.99 }]);
    const res = await svc.ingestCandidate(candidate as any);
    expect(res.status).toBe('deduped');
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'deduped');
  });
  it('returns rejected (and does not persist) when the trust gate rejects', async () => {
    retrieval.search.mockResolvedValue([]);
    trustGate.evaluate.mockResolvedValue({ decision: 'reject', reason: 'Failed safety filter' });
    jest.spyOn(svc, 'submitDraft');
    const res = await svc.ingestCandidate(candidate as any);
    expect(res.status).toBe('rejected');
    expect(svc.submitDraft).not.toHaveBeenCalled();
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'rejected');
  });
  it('submits a novel, safe candidate as a queued draft and forces research-agent trust', async () => {
    retrieval.search.mockResolvedValue([]);
    trustGate.evaluate.mockResolvedValue({ decision: 'queue', reason: 'ok' });
    jest.spyOn(svc, 'submitDraft').mockResolvedValue({ id: 'draft-1', status: 'pending-review' } as any);
    const res = await svc.ingestCandidate(candidate as any);
    expect(res).toEqual({ status: 'submitted', draftId: 'draft-1' });
    const submitted = (svc.submitDraft as jest.Mock).mock.calls[0][0];
    expect(submitted.trustLevel).toBe('research-agent');
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'submitted');
  });
});
