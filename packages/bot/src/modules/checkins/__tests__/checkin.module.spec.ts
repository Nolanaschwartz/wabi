// CheckInModule → CheckInService statically imports pg-boss (ESM); stub it so jest can parse.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    createQueue: jest.fn(),
    schedule: jest.fn(),
    work: jest.fn(),
    stop: jest.fn(),
  })),
}));

import { CheckInModule } from '../checkin.module';
import type { CheckInService } from '../checkin.service';

// The scheduler only runs if the module drives the service lifecycle: init() schedules the cron +
// worker, destroy() stops the pg-boss client. Without OnModuleInit wiring the check-in DMs never
// fire — init() sits defined-but-uncalled (the bug this test guards).
describe('CheckInModule lifecycle', () => {
  it('starts the scheduler on module init', async () => {
    const service = { init: jest.fn().mockResolvedValue(undefined) } as unknown as CheckInService;
    const module = new CheckInModule(service);

    await module.onModuleInit();

    expect(service.init).toHaveBeenCalledTimes(1);
  });

  it('stops the scheduler on module destroy', async () => {
    const service = { destroy: jest.fn().mockResolvedValue(undefined) } as unknown as CheckInService;
    const module = new CheckInModule(service);

    await module.onModuleDestroy();

    expect(service.destroy).toHaveBeenCalledTimes(1);
  });
});
