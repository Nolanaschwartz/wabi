const mockBoss = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
  unschedule: jest.fn().mockResolvedValue(undefined),
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
    // Every op is a silent no-op in degraded mode.
    await scheduler.work('q', jest.fn());
    await scheduler.send('q', {});
    await scheduler.schedule('q', '* * * * *', {}, { tz: 'UTC' });
    await scheduler.unschedule('q');
    expect(mockBoss.createQueue).not.toHaveBeenCalled();
    expect(mockBoss.send).not.toHaveBeenCalled();
    expect(mockBoss.schedule).not.toHaveBeenCalled();
    expect(mockBoss.unschedule).not.toHaveBeenCalled();
  });

  it('schedule() forwards cron + payload + options (tz)', async () => {
    await scheduler.start();
    await scheduler.schedule('research-run', '0 3 * * *', {}, { tz: 'America/New_York' });
    expect(mockBoss.schedule).toHaveBeenCalledWith('research-run', '0 3 * * *', {}, {
      tz: 'America/New_York',
    });
  });

  it('unschedule() removes the cron entry', async () => {
    await scheduler.start();
    await scheduler.unschedule('research-run');
    expect(mockBoss.unschedule).toHaveBeenCalledWith('research-run');
  });

  it('work() creates the queue and binds the handler', async () => {
    await scheduler.start();
    const handler = jest.fn();
    await scheduler.work('research-run', handler);
    expect(mockBoss.createQueue).toHaveBeenCalledWith('research-run');
    expect(mockBoss.work).toHaveBeenCalledWith('research-run', handler);
  });

  it('send() enqueues a one-off job', async () => {
    await scheduler.start();
    await scheduler.send('research-run', { trigger: 'manual' });
    expect(mockBoss.send).toHaveBeenCalledWith('research-run', { trigger: 'manual' });
  });

  it('stop() shuts the client down and returns to degraded', async () => {
    await scheduler.start();
    await scheduler.stop();
    expect(mockBoss.stop).toHaveBeenCalledTimes(1);
    expect(scheduler.available).toBe(false);
  });
});
