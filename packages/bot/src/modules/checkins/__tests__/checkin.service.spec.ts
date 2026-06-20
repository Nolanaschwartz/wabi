// Keep the heavy deps (pg-boss/discord.js/coaching chain) out of the import graph; this spec only
// exercises the check-in cron fan-out and its concurrency cap.
jest.mock('@wabi/shared', () => ({ prisma: { user: { update: jest.fn() } } }));
jest.mock('../../coaching/coaching.service', () => ({ CoachingService: jest.fn() }));

import { CheckInService } from '../checkin.service';

describe('CheckInService.handleCheckIns fan-out', () => {
  function build(dueCount: number) {
    const dueUsers = Array.from({ length: dueCount }, (_, i) => ({
      discordId: `u${i}`,
      timezone: 'UTC',
    }));

    let inFlight = 0;
    let peak = 0;
    const sent: string[] = [];

    const client = {
      users: {
        send: jest.fn().mockImplementation(async (id: string) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setImmediate(r));
          sent.push(id);
          inFlight--;
          return {};
        }),
      },
    };
    const scheduler = {
      findDueUsers: jest.fn().mockResolvedValue(dueUsers),
      recordCheckIn: jest.fn().mockResolvedValue(undefined),
    };

    const service = new CheckInService(
      scheduler as any,
      {} as any,
      client as any,
      { declare: jest.fn() } as any,
    );

    return { service, client, scheduler, sent, peak: () => peak };
  }

  it('sends to every due user but keeps at most 5 sends in flight at once', async () => {
    const { service, client, scheduler, sent, peak } = build(20);

    await (service as any).handleCheckIns();

    expect(client.users.send).toHaveBeenCalledTimes(20);
    expect(scheduler.recordCheckIn).toHaveBeenCalledTimes(20);
    expect(new Set(sent).size).toBe(20);
    expect(peak()).toBeLessThanOrEqual(5);
  });

  it('one blocked-DM failure does not sink the batch', async () => {
    const { service, client, scheduler } = build(6);
    (client.users.send as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('Cannot send messages to this user');
    });

    await expect((service as any).handleCheckIns()).resolves.toBeUndefined();

    // The failing send's recordCheckIn is skipped; the other five still run.
    expect(scheduler.recordCheckIn).toHaveBeenCalledTimes(5);
  });
});
