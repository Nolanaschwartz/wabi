// SchedulerService (imported transitively by some owners) pulls in pg-boss, an ESM-only package
// jest can't parse; mock it so the owner imports resolve.
jest.mock('pg-boss', () => ({ PgBoss: jest.fn() }));

import { JobRegistry } from '../job-registry';
import { Job } from '../jobs';
import { SessionSweeper } from '../../session-buffer/session-sweeper.service';
import { TiltService } from '../../tilt/tilt.service';
import { StrategyAdminService } from '../../strategy-admin/strategy-admin.service';
import { CrisisAftermathService } from '../../crisis-aftermath/crisis-aftermath.service';
import { CheckInService } from '../../checkins/checkin.service';

/**
 * The completeness contract (mirrors data-rights' source list): every `Job` is declared by exactly
 * one owner at boot. A new enum member with no owner, or two owners claiming the same queue, fails
 * here rather than silently never registering / double-binding in production.
 *
 * The declaration entrypoint of every Scheduler-backed module is driven against one shared registry.
 * Each is constructed with stub deps — `init`/`onModuleInit` only touches the registry.
 */
describe('Job registry completeness', () => {
  const registry = new JobRegistry();
  const stub = {} as any;

  beforeAll(() => {
    new SessionSweeper(stub, stub, stub, registry).onModuleInit();
    new TiltService(stub, registry).init();
    new StrategyAdminService(stub, stub, stub, registry).init();
    new CrisisAftermathService(stub, stub, stub, stub, stub, registry).init();
    new CheckInService(stub, stub, stub, registry).init();
  });

  it('declares every Job exactly once', () => {
    const declared = registry.all().map((j) => j.name).sort();
    const expected = Object.values(Job).sort();
    expect(declared).toEqual(expected);
  });

  it('declares no Job twice', () => {
    const names = registry.all().map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every cron job a cron expression and every work job none', () => {
    for (const def of registry.all()) {
      if (def.kind === 'cron') {
        expect(def.cron).toBeTruthy();
      } else {
        expect('cron' in def).toBe(false);
      }
    }
  });
});
