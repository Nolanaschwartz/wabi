import { StrategyDraftStateMachine } from '../strategy-draft-state-machine.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    strategyDraft: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('StrategyDraftStateMachine', () => {
  let sm: StrategyDraftStateMachine;

  beforeEach(() => {
    jest.clearAllMocks();
    sm = new StrategyDraftStateMachine();
  });

  it('returns null and never writes when the draft is missing', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue(null);

    expect(await sm.transition('x', 'approve')).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });

  it('returns null and never writes on an illegal transition', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({ id: '1', status: 'published' });

    expect(await sm.transition('1', 'approve')).toBeNull();
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });

  it('writes the next status on a legal transition and returns the updated row', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({ id: '1', status: 'pending-review' });
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({ id: '1', status: 'published' });

    const row = await sm.transition('1', 'approve');

    expect(prisma.strategyDraft.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { status: 'published' },
    });
    expect(row).toEqual({ id: '1', status: 'published' });
  });

  it('runs the precommit before the write and vetoes (no write) when it returns false', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({ id: '1', status: 'pending-review' });
    const precommit = jest.fn().mockResolvedValue(false);

    expect(await sm.transition('1', 'approve', { precommit })).toBeNull();
    expect(precommit).toHaveBeenCalledWith({ id: '1', status: 'pending-review' });
    expect(prisma.strategyDraft.update).not.toHaveBeenCalled();
  });

  it('proceeds to the write when the precommit passes', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({ id: '1', status: 'pending-review' });
    (prisma.strategyDraft.update as jest.Mock).mockResolvedValue({ id: '1', status: 'published' });
    const precommit = jest.fn().mockResolvedValue(true);

    const row = await sm.transition('1', 'approve', { precommit });

    expect(row).toEqual({ id: '1', status: 'published' });
    expect(prisma.strategyDraft.update).toHaveBeenCalled();
  });

  it('returns null when the status write fails', async () => {
    (prisma.strategyDraft.findUnique as jest.Mock).mockResolvedValue({ id: '1', status: 'pending-review' });
    (prisma.strategyDraft.update as jest.Mock).mockRejectedValue(new Error('db down'));

    expect(await sm.transition('1', 'reject')).toBeNull();
  });
});
