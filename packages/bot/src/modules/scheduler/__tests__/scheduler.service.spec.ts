const mockBoss = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
  work: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
};

jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => mockBoss),
}));

import { SchedulerService } from '../scheduler.service';
import { JobRegistry } from '../job-registry';
import { Job } from '../jobs';

describe('SchedulerService', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    scheduler = new SchedulerService();
  });

  it('is unavailable before start and available after', async () => {
    expect(scheduler.available).toBe(false);
    await scheduler.start();
    expect(mockBoss.start).toHaveBeenCalledTimes(1);
    expect(scheduler.available).toBe(true);
  });

  it('stays degraded (no client) when DATABASE_URL is absent', async () => {
    delete process.env.DATABASE_URL;
    await scheduler.start();
    expect(scheduler.available).toBe(false);
    // Enqueue is a silent no-op in degraded mode.
    await scheduler.send('q', {});
    expect(mockBoss.createQueue).not.toHaveBeenCalled();
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  it('send() enqueues a one-off job', async () => {
    await scheduler.start();
    await scheduler.send('strategy-demote', { draftId: 'd1' });
    expect(mockBoss.send).toHaveBeenCalledWith('strategy-demote', { draftId: 'd1' });
  });

  it('stop() shuts the client down and returns to degraded', async () => {
    await scheduler.start();
    await scheduler.stop();
    expect(mockBoss.stop).toHaveBeenCalledTimes(1);
    expect(scheduler.available).toBe(false);
  });

  describe('drainRegistry', () => {
    it('registers every declared job and reports them as registered', async () => {
      await scheduler.start();
      const registry = new JobRegistry();
      const sweepHandler = jest.fn();
      const demoteHandler = jest.fn();
      registry.declare({
        name: Job.SessionSweep,
        kind: 'cron',
        cron: '*/5 * * * *',
        owner: 'session-buffer',
        handler: sweepHandler,
      });
      registry.declare({
        name: Job.StrategyDemote,
        kind: 'work',
        owner: 'strategy-admin',
        handler: demoteHandler,
      });

      await scheduler.drainRegistry(registry);

      expect(mockBoss.createQueue).toHaveBeenCalledWith(Job.SessionSweep);
      expect(mockBoss.schedule).toHaveBeenCalledWith(Job.SessionSweep, '*/5 * * * *');
      expect(mockBoss.work).toHaveBeenCalledWith(Job.SessionSweep, sweepHandler);
      expect(mockBoss.createQueue).toHaveBeenCalledWith(Job.StrategyDemote);
      expect(mockBoss.work).toHaveBeenCalledWith(Job.StrategyDemote, demoteHandler);

      expect(scheduler.jobStatus).toEqual({
        registered: [Job.SessionSweep, Job.StrategyDemote],
        degraded: [],
        failed: [],
      });
    });

    it('marks every job degraded and binds nothing when the client is down', async () => {
      delete process.env.DATABASE_URL;
      await scheduler.start();
      const registry = new JobRegistry();
      registry.declare({
        name: Job.SessionSweep,
        kind: 'cron',
        cron: '*/5 * * * *',
        owner: 'session-buffer',
        handler: jest.fn(),
      });

      await scheduler.drainRegistry(registry);

      expect(mockBoss.createQueue).not.toHaveBeenCalled();
      expect(scheduler.jobStatus).toEqual({
        registered: [],
        degraded: [Job.SessionSweep],
        failed: [],
      });
    });

    it('isolates a job that fails to bind — the rest still register', async () => {
      await scheduler.start();
      mockBoss.createQueue.mockImplementation((queue: string) => {
        if (queue === Job.SessionSweep) throw new Error('boom');
        return Promise.resolve();
      });
      const registry = new JobRegistry();
      registry.declare({
        name: Job.SessionSweep,
        kind: 'cron',
        cron: '*/5 * * * *',
        owner: 'session-buffer',
        handler: jest.fn(),
      });
      registry.declare({
        name: Job.StrategyDemote,
        kind: 'work',
        owner: 'strategy-admin',
        handler: jest.fn(),
      });

      await scheduler.drainRegistry(registry);

      expect(scheduler.jobStatus).toEqual({
        registered: [Job.StrategyDemote],
        degraded: [],
        failed: [Job.SessionSweep],
      });
    });
  });
});
