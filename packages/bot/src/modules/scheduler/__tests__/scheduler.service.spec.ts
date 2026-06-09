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
    // Registrations are silent no-ops in degraded mode.
    await scheduler.work('q', jest.fn());
    await scheduler.cron('q', '* * * * *', jest.fn());
    await scheduler.send('q', {});
    expect(mockBoss.createQueue).not.toHaveBeenCalled();
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  it('work() creates the queue and binds the handler', async () => {
    await scheduler.start();
    const handler = jest.fn();
    await scheduler.work('crisis-follow-up', handler);
    expect(mockBoss.createQueue).toHaveBeenCalledWith('crisis-follow-up');
    expect(mockBoss.work).toHaveBeenCalledWith('crisis-follow-up', handler);
    expect(mockBoss.schedule).not.toHaveBeenCalled();
  });

  it('cron() creates the queue, schedules the cron, and binds the handler', async () => {
    await scheduler.start();
    const handler = jest.fn();
    await scheduler.cron('session-sweeper', '*/5 * * * *', handler);
    expect(mockBoss.createQueue).toHaveBeenCalledWith('session-sweeper');
    expect(mockBoss.schedule).toHaveBeenCalledWith('session-sweeper', '*/5 * * * *');
    expect(mockBoss.work).toHaveBeenCalledWith('session-sweeper', handler);
  });

  it('send() enqueues a one-off job', async () => {
    await scheduler.start();
    await scheduler.send('strategy-demote', { draftId: 'd1' });
    expect(mockBoss.send).toHaveBeenCalledWith('strategy-demote', { draftId: 'd1' });
  });

  it('schedule() forwards pg-boss schedule semantics with payload (crisis follow-up)', async () => {
    await scheduler.start();
    await scheduler.schedule('crisis-follow-up', '30 minutes', { userId: '123', message: 'hi' });
    expect(mockBoss.schedule).toHaveBeenCalledWith('crisis-follow-up', '30 minutes', {
      userId: '123',
      message: 'hi',
    });
  });

  it('stop() shuts the client down and returns to degraded', async () => {
    await scheduler.start();
    await scheduler.stop();
    expect(mockBoss.stop).toHaveBeenCalledTimes(1);
    expect(scheduler.available).toBe(false);
  });
});
