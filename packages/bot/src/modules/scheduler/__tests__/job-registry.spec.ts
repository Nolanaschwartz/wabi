import { JobRegistry } from '../job-registry';
import { Job } from '../jobs';

describe('JobRegistry', () => {
  it('returns every declared job', () => {
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

    expect(registry.all().map((j) => j.name)).toEqual([Job.SessionSweep, Job.StrategyDemote]);
  });
});
