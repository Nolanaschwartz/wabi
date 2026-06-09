// CheckInModule → CheckInService → SchedulerService (which imports pg-boss, ESM). Stub the
// Scheduler so jest can parse the module graph without loading pg-boss.
jest.mock('../../scheduler/scheduler.service', () => ({
  SchedulerService: jest.fn(),
}));

import { CheckInModule } from '../checkin.module';
import type { CheckInService } from '../checkin.service';

// The check-in cron only registers if the module drives init() on startup. Without OnModuleInit
// wiring the DMs never fire — init() sits defined-but-uncalled (the bug this test guards). The
// pg-boss client lifecycle (stop) is the shared Scheduler's job, not this module's.
describe('CheckInModule lifecycle', () => {
  it('registers the check-in cron on module init', async () => {
    const service = { init: jest.fn().mockResolvedValue(undefined) } as unknown as CheckInService;
    const module = new CheckInModule(service);

    await module.onModuleInit();

    expect(service.init).toHaveBeenCalledTimes(1);
  });
});
