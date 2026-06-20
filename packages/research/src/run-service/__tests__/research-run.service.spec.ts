// pg-boss is ESM-only; mock it so importing SchedulerService (transitively, for DI typing) does not
// load the real module under jest's CommonJS runtime.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

// Mock the shared prisma singleton — the service uses it directly (codebase pattern).
const prismaMock = {
  researchRun: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  researchConfig: {
    findUnique: jest.fn(),
  },
};

jest.mock('@wabi/shared', () => ({
  get prisma() {
    return prismaMock;
  },
}));

import { ResearchRunService, RESEARCH_RUN_QUEUE } from '../research-run.service';
import type { SchedulerService } from '../../scheduler/scheduler.service';
import type { ResearchConfigService } from '../../config-service/research-config.service';
import type { ResearchRunnerService, RunnerResult } from '../research-runner.service';

function makeScheduler() {
  return {
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<SchedulerService, 'work' | 'send'>> & SchedulerService;
}

/** A zero-count runner result — the default when a test doesn't care about the summary mapping. */
const ZERO_RESULT: RunnerResult = {
  submitted: 0, deduped: 0, rejected: 0, errors: 0, collected: 0,
  stopReason: 'exhausted', tokensUsed: 0, topicsRun: 0,
};

function makeConfig(): jest.Mocked<Pick<ResearchConfigService, 'getEnabledTopics' | 'getConfig'>> & ResearchConfigService {
  return {
    getEnabledTopics: jest.fn().mockResolvedValue([]),
    getConfig: jest.fn().mockResolvedValue({ config: null, topics: [] }),
  } as unknown as jest.Mocked<Pick<ResearchConfigService, 'getEnabledTopics' | 'getConfig'>> & ResearchConfigService;
}

function makeRunner(result: RunnerResult = ZERO_RESULT): jest.Mocked<Pick<ResearchRunnerService, 'execute'>> & ResearchRunnerService {
  return {
    execute: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<Pick<ResearchRunnerService, 'execute'>> & ResearchRunnerService;
}

/** Default bounds the config singleton would yield (schema defaults). */
const DEFAULT_BOUNDS = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 24, searchLimit: 40, maxDiscoverySteps: 2, maxDraftsPerTopic: 3,
  maxDraftsPerRun: 10, agentTimeoutMs: 90_000, runTimeoutMs: 600_000, tokenBudget: 200_000,
};

/** Build the 3-arg service the new slice expects (scheduler, config, runner). */
function makeService(
  scheduler = makeScheduler(),
  config = makeConfig(),
  runner = makeRunner(),
) {
  return new ResearchRunService(scheduler, config, runner);
}

describe('ResearchRunService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No running row by default (single-flight guard passes).
    prismaMock.researchRun.findFirst.mockResolvedValue(null);
    prismaMock.researchRun.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'run-new', ...data }),
    );
    prismaMock.researchRun.update.mockImplementation(({ where, data }: any) =>
      Promise.resolve({ id: where.id, ...data }),
    );
    prismaMock.researchRun.updateMany.mockResolvedValue({ count: 0 });
    // Config singleton with the default run timeout (staleness threshold).
    prismaMock.researchConfig.findUnique.mockResolvedValue({ runTimeoutMs: 600000 });
  });

  describe('onModuleInit — consumer registration', () => {
    it('registers the research-run consumer as a singleton queue', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);

      await svc.onModuleInit();

      expect(scheduler.work).toHaveBeenCalledTimes(1);
      const [queue, handler, options] = scheduler.work.mock.calls[0];
      expect(queue).toBe(RESEARCH_RUN_QUEUE);
      expect(typeof handler).toBe('function');
      expect(options).toEqual({ policy: 'singleton' });
    });
  });

  describe('handleJob — real run', () => {
    it('a scheduled firing (no runId) creates a running row, runs, and finalizes to success with the REAL summary counts', async () => {
      const scheduler = makeScheduler();
      const config = makeConfig();
      const runner = makeRunner({
        submitted: 4, deduped: 2, rejected: 1, errors: 0, collected: 7,
        stopReason: 'maxDraftsPerRun', tokensUsed: 5_000, topicsRun: 3,
      });
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      // running row created first…
      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'scheduled', status: 'running' },
      });
      // …then finalized to success with the runner's REAL counts.
      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-new' });
      expect(updateArg.data.status).toBe('success');
      expect(updateArg.data.finishedAt).toBeInstanceOf(Date);
      expect(updateArg.data.submitted).toBe(4);
      expect(updateArg.data.deduped).toBe(2);
      expect(updateArg.data.rejected).toBe(1);
      expect(updateArg.data.errors).toBe(0);
      expect(updateArg.data.collected).toBe(7);
      expect(updateArg.data.tokensUsed).toBe(5_000);
      expect(updateArg.data.topicsRun).toBe(3);
      expect(updateArg.data.stopReason).toBe('maxDraftsPerRun');
    });

    it('loads enabled topics + bounds from the DATABASE and drives the runner with them (not env/SEED_TOPICS)', async () => {
      const scheduler = makeScheduler();
      const config = makeConfig();
      config.getEnabledTopics.mockResolvedValue([{ text: 'stress' }, { text: 'sleep' }]);
      // Config singleton carries the eight bounds columns (non-default values to prove they drive the run).
      prismaMock.researchConfig.findUnique.mockResolvedValue({
        maxTopicsPerRun: 7, maxPapersPerTopic: 9, maxDiscoverySteps: 3, maxDraftsPerTopic: 4,
        maxDraftsPerRun: 12, agentTimeoutMs: 80_000, runTimeoutMs: 500_000, tokenBudget: 150_000,
      });
      const runner = makeRunner();
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      expect(config.getEnabledTopics).toHaveBeenCalled();
      expect(runner.execute).toHaveBeenCalledTimes(1);
      const arg = runner.execute.mock.calls[0][0];
      expect(arg.topics).toEqual(['stress', 'sleep']);
      expect(arg.bounds).toEqual({
        maxTopicsPerRun: 7, maxPapersPerTopic: 9, searchLimit: 40, maxDiscoverySteps: 3, maxDraftsPerTopic: 4,
        maxDraftsPerRun: 12, agentTimeoutMs: 80_000, runTimeoutMs: 500_000, tokenBudget: 150_000,
      });
    });

    it('falls back to the schema-default bounds when the config singleton is missing (degraded read)', async () => {
      const scheduler = makeScheduler();
      const config = makeConfig();
      prismaMock.researchConfig.findUnique.mockResolvedValue(null);
      const runner = makeRunner();
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      const arg = runner.execute.mock.calls[0][0];
      expect(arg.bounds).toEqual(DEFAULT_BOUNDS);
    });

    it('running-row lifecycle: the row is created running BEFORE the runner executes', async () => {
      const calls: string[] = [];
      const scheduler = makeScheduler();
      const config = makeConfig();
      const runner = makeRunner();
      prismaMock.researchRun.create.mockImplementation(({ data }: any) => {
        calls.push('create');
        return Promise.resolve({ id: 'run-new', ...data });
      });
      runner.execute.mockImplementation(async () => { calls.push('execute'); return ZERO_RESULT; });
      prismaMock.researchRun.update.mockImplementation(({ where, data }: any) => {
        calls.push('finalize');
        return Promise.resolve({ id: where.id, ...data });
      });
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      expect(calls).toEqual(['create', 'execute', 'finalize']);
    });

    it('defaults the trigger to scheduled when the payload omits it', async () => {
      const svc = makeService();

      await svc.handleJob({});

      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'scheduled', status: 'running' },
      });
    });

    it('finalizes an EXISTING row (manual path) when the payload carries a runId — does not create a second row', async () => {
      const svc = makeService();

      await svc.handleJob({ runId: 'run-manual-1', trigger: 'manual' });

      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-manual-1' });
      expect(updateArg.data.status).toBe('success');
    });

    it('failure path: a runner throw finalizes the row to failed with the error captured (single-flight released)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const config = makeConfig();
      const runner = makeRunner();
      runner.execute.mockRejectedValue(new Error('search exploded'));
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-new' });
      expect(updateArg.data.status).toBe('failed');
      expect(updateArg.data.finishedAt).toBeInstanceOf(Date);
      expect(updateArg.data.error).toEqual(expect.stringContaining('search exploded'));
      errSpy.mockRestore();
    });

    it('failure path: a runner throw on the MANUAL path finalizes the existing row to failed', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const config = makeConfig();
      const runner = makeRunner();
      runner.execute.mockRejectedValue(new Error('boom'));
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ runId: 'run-manual-x', trigger: 'manual' });

      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-manual-x' });
      expect(updateArg.data.status).toBe('failed');
      errSpy.mockRestore();
    });

    it('single-flight: a scheduled firing while a running row exists collapses (no run, no second row)', async () => {
      const scheduler = makeScheduler();
      const config = makeConfig();
      const runner = makeRunner();
      prismaMock.researchRun.findFirst.mockResolvedValue({ id: 'run-active', status: 'running' });
      const svc = makeService(scheduler, config, runner);

      await svc.handleJob({ trigger: 'scheduled' });

      // The DB guard sees an active run → no new row, no run executed, nothing finalized.
      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(runner.execute).not.toHaveBeenCalled();
      expect(prismaMock.researchRun.update).not.toHaveBeenCalled();
    });
  });

  describe('triggerManualRun', () => {
    it('creates a running row with trigger=manual, enqueues with its runId, and returns the id', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.create.mockResolvedValue({ id: 'run-42', trigger: 'manual', status: 'running' });

      const result = await svc.triggerManualRun();

      expect(result).toEqual({ runId: 'run-42' });
      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'manual', status: 'running' },
      });
      expect(scheduler.send).toHaveBeenCalledWith(RESEARCH_RUN_QUEUE, {
        runId: 'run-42',
        trigger: 'manual',
      });
    });

    it('single-flight: collapses to the existing running run id when one is already active (no second row, no enqueue)', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.findFirst.mockResolvedValue({ id: 'run-active', status: 'running' });

      const result = await svc.triggerManualRun();

      expect(result).toEqual({ runId: 'run-active' });
      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(scheduler.send).not.toHaveBeenCalled();
    });

    it('fails gracefully when degraded (no DB row created) — returns a clear no-op result instead of throwing', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.create.mockRejectedValue(new Error('db down'));

      await expect(svc.triggerManualRun()).resolves.toEqual({ runId: null });
      expect(scheduler.send).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('finalizes the created row to failed when enqueue throws AFTER row creation — releases single-flight (Fix 1)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.create.mockResolvedValue({
        id: 'run-orphan',
        trigger: 'manual',
        status: 'running',
      });
      (scheduler.send as jest.Mock).mockRejectedValue(new Error('pg-boss send blew up'));

      const result = await svc.triggerManualRun();

      // Degraded contract — operator sees a clear no-op.
      expect(result).toEqual({ runId: null });
      // The orphaned `running` row is finalized to `failed` so single-flight is released.
      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-orphan' });
      expect(updateArg.data.status).toBe('failed');
      expect(updateArg.data.finishedAt).toBeInstanceOf(Date);
      expect(updateArg.data.error).toEqual(expect.any(String));
      expect(updateArg.data.error.length).toBeGreaterThan(0);
      errSpy.mockRestore();
    });

    it('does NOT attempt a failed-finalize when create itself throws (degraded DB, no row to release)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.create.mockRejectedValue(new Error('db down'));

      await expect(svc.triggerManualRun()).resolves.toEqual({ runId: null });
      // No row was created, so there is nothing to finalize.
      expect(prismaMock.researchRun.update).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe('single-flight staleness (Fix 2)', () => {
    it('a running row older than runTimeoutMs does NOT block a new manual run', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      const stale = {
        id: 'run-stale',
        status: 'running',
        startedAt: new Date(Date.now() - 600000 - 60000), // older than 600000ms timeout
      };
      prismaMock.researchRun.findFirst.mockResolvedValue(stale);
      prismaMock.researchRun.create.mockResolvedValue({
        id: 'run-fresh',
        trigger: 'manual',
        status: 'running',
      });

      const result = await svc.triggerManualRun();

      // The stale row is ignored → a brand-new run proceeds.
      expect(result).toEqual({ runId: 'run-fresh' });
      expect(prismaMock.researchRun.create).toHaveBeenCalled();
      expect(scheduler.send).toHaveBeenCalled();
    });

    it('a running row within the timeout window still blocks (collapses) as before', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.findFirst.mockResolvedValue({
        id: 'run-active',
        status: 'running',
        startedAt: new Date(Date.now() - 1000), // well within the 600000ms window
      });

      const result = await svc.triggerManualRun();

      expect(result).toEqual({ runId: 'run-active' });
      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(scheduler.send).not.toHaveBeenCalled();
    });

    it('a stale running row does NOT block a scheduled firing (handleJob proceeds to create a new row)', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.findFirst.mockResolvedValue({
        id: 'run-stale',
        status: 'running',
        startedAt: new Date(Date.now() - 600000 - 60000),
      });

      await svc.handleJob({ trigger: 'scheduled' });

      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'scheduled', status: 'running' },
      });
    });

    it('falls back to the default threshold (does not throw) when reading runTimeoutMs fails', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchConfig.findUnique.mockRejectedValue(new Error('config read failed'));
      // A row old enough to be stale under the default 600000ms fallback.
      prismaMock.researchRun.findFirst.mockResolvedValue({
        id: 'run-stale',
        status: 'running',
        startedAt: new Date(Date.now() - 600000 - 60000),
      });
      prismaMock.researchRun.create.mockResolvedValue({
        id: 'run-fresh',
        trigger: 'manual',
        status: 'running',
      });

      const result = await svc.triggerManualRun();

      expect(result).toEqual({ runId: 'run-fresh' });
      errSpy.mockRestore();
    });
  });

  describe('listRuns', () => {
    it('returns recent rows ordered by startedAt desc with the limit applied', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      const rows = [{ id: 'r2' }, { id: 'r1' }];
      prismaMock.researchRun.findMany.mockResolvedValue(rows);

      const result = await svc.listRuns(5);

      expect(result).toEqual(rows);
      expect(prismaMock.researchRun.findMany).toHaveBeenCalledWith({
        orderBy: { startedAt: 'desc' },
        take: 5,
      });
    });

    it('defaults to 20 and clamps an oversized limit to a sane max', async () => {
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.findMany.mockResolvedValue([]);

      await svc.listRuns();
      expect(prismaMock.researchRun.findMany.mock.calls[0][0].take).toBe(20);

      await svc.listRuns(10000);
      expect(prismaMock.researchRun.findMany.mock.calls[1][0].take).toBe(100);

      await svc.listRuns(0);
      expect(prismaMock.researchRun.findMany.mock.calls[2][0].take).toBe(20);
    });

    it('fails gracefully when degraded — returns an empty list instead of throwing', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = makeService(scheduler);
      prismaMock.researchRun.findMany.mockRejectedValue(new Error('db down'));

      await expect(svc.listRuns()).resolves.toEqual([]);
      errSpy.mockRestore();
    });
  });
});
