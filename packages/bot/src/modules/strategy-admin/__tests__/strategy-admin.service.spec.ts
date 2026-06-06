import { StrategyAdminService } from '../strategy-admin.service';
import { StrategyTrustGate } from '../strategy-trust-gate';
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

jest.mock('../strategy-trust-gate', () => ({
  StrategyTrustGate: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn(),
    shouldQuarantine: jest.fn(),
  })),
}));

describe('StrategyAdminService', () => {
  let service: StrategyAdminService;
  let trustGate: jest.Mocked<StrategyTrustGate>;

  beforeEach(() => {
    jest.clearAllMocks();
    trustGate = new StrategyTrustGate() as any;
    service = new StrategyAdminService(trustGate);
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
  });

  it('returns null for non-existent draft approval', async () => {
    (prisma.strategyDraft.update as jest.Mock).mockRejectedValue(new Error('not found'));
    const result = await service.approveDraft('999');
    expect(result).toBeNull();
  });

  it('accumulates negative feedback and auto-quarantines at threshold', async () => {
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
