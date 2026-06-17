// pg-boss is ESM-only; mock it so importing SchedulerService (transitively, for DI typing) does not
// load the real module under jest's CommonJS runtime.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

// Mock the shared prisma singleton — the service uses it directly (codebase pattern).
const prismaMock = {
  researchRun: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.mock('@wabi/shared', () => ({
  get prisma() {
    return prismaMock;
  },
}));

import { ResearchRunService, RESEARCH_RUN_QUEUE } from '../research-run.service';
import type { SchedulerService } from '../../scheduler/scheduler.service';

function makeScheduler() {
  return {
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<SchedulerService, 'work' | 'send'>> & SchedulerService;
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
  });

  describe('onModuleInit — consumer registration', () => {
    it('registers the research-run consumer as a singleton queue', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);

      await svc.onModuleInit();

      expect(scheduler.work).toHaveBeenCalledTimes(1);
      const [queue, handler, options] = scheduler.work.mock.calls[0];
      expect(queue).toBe(RESEARCH_RUN_QUEUE);
      expect(typeof handler).toBe('function');
      expect(options).toEqual({ policy: 'singleton' });
    });
  });

  describe('handleJob — heartbeat', () => {
    it('a scheduled firing (no runId) creates a running row with trigger=scheduled and finalizes to success with zero counts', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);

      await svc.handleJob({ trigger: 'scheduled' });

      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'scheduled', status: 'running' },
      });
      // Finalized to success with zero counts and a finishedAt.
      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-new' });
      expect(updateArg.data.status).toBe('success');
      expect(updateArg.data.finishedAt).toBeInstanceOf(Date);
      expect(updateArg.data.submitted).toBe(0);
      expect(updateArg.data.deduped).toBe(0);
      expect(updateArg.data.rejected).toBe(0);
      expect(updateArg.data.errors).toBe(0);
    });

    it('defaults the trigger to scheduled when the payload omits it', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);

      await svc.handleJob({});

      expect(prismaMock.researchRun.create).toHaveBeenCalledWith({
        data: { trigger: 'scheduled', status: 'running' },
      });
    });

    it('finalizes an EXISTING row (manual path) when the payload carries a runId — does not create a second row', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);

      await svc.handleJob({ runId: 'run-manual-1', trigger: 'manual' });

      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(prismaMock.researchRun.update).toHaveBeenCalledTimes(1);
      const updateArg = prismaMock.researchRun.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'run-manual-1' });
      expect(updateArg.data.status).toBe('success');
    });

    it('single-flight: a scheduled firing while a running row exists collapses (no second running row)', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);
      prismaMock.researchRun.findFirst.mockResolvedValue({ id: 'run-active', status: 'running' });

      await svc.handleJob({ trigger: 'scheduled' });

      // The DB guard sees an active run → no new row is created and nothing is finalized.
      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(prismaMock.researchRun.update).not.toHaveBeenCalled();
    });
  });

  describe('triggerManualRun', () => {
    it('creates a running row with trigger=manual, enqueues with its runId, and returns the id', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);
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
      const svc = new ResearchRunService(scheduler);
      prismaMock.researchRun.findFirst.mockResolvedValue({ id: 'run-active', status: 'running' });

      const result = await svc.triggerManualRun();

      expect(result).toEqual({ runId: 'run-active' });
      expect(prismaMock.researchRun.create).not.toHaveBeenCalled();
      expect(scheduler.send).not.toHaveBeenCalled();
    });

    it('fails gracefully when degraded (no DB row created) — returns a clear no-op result instead of throwing', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);
      prismaMock.researchRun.create.mockRejectedValue(new Error('db down'));

      await expect(svc.triggerManualRun()).resolves.toEqual({ runId: null });
      expect(scheduler.send).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe('listRuns', () => {
    it('returns recent rows ordered by startedAt desc with the limit applied', async () => {
      const scheduler = makeScheduler();
      const svc = new ResearchRunService(scheduler);
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
      const svc = new ResearchRunService(scheduler);
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
      const svc = new ResearchRunService(scheduler);
      prismaMock.researchRun.findMany.mockRejectedValue(new Error('db down'));

      await expect(svc.listRuns()).resolves.toEqual([]);
      errSpy.mockRestore();
    });
  });
});
