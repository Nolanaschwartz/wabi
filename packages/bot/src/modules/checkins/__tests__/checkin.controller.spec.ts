// Mock the decorator and the heavy service module so this spec loads only the controller
// logic (the real CheckInService pulls in pg-boss/discord.js/the coaching chain).
jest.mock('necord', () => ({ SlashCommand: () => () => {}, Context: () => () => {} }));
jest.mock('../checkin.service', () => ({ CheckInService: jest.fn() }));
jest.mock('@wabi/shared', () => ({ prisma: {} }));

import { CheckInController } from '../checkin.controller';
import { CheckInService } from '../checkin.service';

function mockInteraction(options: {
  enabled?: boolean | null;
  cadence?: string | null;
  timezone?: string | null;
}) {
  const editReply = jest.fn().mockResolvedValue({});
  return {
    interaction: {
      deferReply: jest.fn().mockResolvedValue({}),
      editReply,
      user: { id: 'user_1' },
      options: {
        getBoolean: (name: string) => (name === 'enabled' ? options.enabled ?? null : null),
        getString: (name: string) =>
          name === 'cadence'
            ? options.cadence ?? null
            : name === 'timezone'
              ? options.timezone ?? null
              : null,
      },
    } as any,
    editReply,
  };
}

describe('CheckInController', () => {
  let controller: CheckInController;
  let service: jest.Mocked<CheckInService>;

  beforeEach(() => {
    service = {
      toggleCheckIn: jest.fn().mockResolvedValue(undefined),
      setCadence: jest.fn().mockResolvedValue(undefined),
      setTimezone: jest.fn().mockResolvedValue('UTC'),
    } as any;
    controller = new CheckInController(service);
  });

  it('shows usage when no options are provided', async () => {
    const { interaction, editReply } = mockInteraction({});
    await controller.execute([interaction]);
    expect(service.toggleCheckIn).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage') }),
    );
  });

  it('enables check-ins', async () => {
    const { interaction } = mockInteraction({ enabled: true });
    await controller.execute([interaction]);
    expect(service.toggleCheckIn).toHaveBeenCalledWith('user_1', true);
  });

  it('sets a valid cadence', async () => {
    const { interaction, editReply } = mockInteraction({ cadence: 'weekly' });
    await controller.execute([interaction]);
    expect(service.setCadence).toHaveBeenCalledWith('user_1', 'weekly');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('weekly') }),
    );
  });

  it('rejects an invalid cadence without persisting', async () => {
    const { interaction, editReply } = mockInteraction({ cadence: 'hourly' });
    await controller.execute([interaction]);
    expect(service.setCadence).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid cadence') }),
    );
  });

  it('sets a valid timezone', async () => {
    service.setTimezone.mockResolvedValue('America/New_York');
    const { interaction, editReply } = mockInteraction({ timezone: 'America/New_York' });
    await controller.execute([interaction]);
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'America/New_York');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('America/New_York') }),
    );
  });

  it('reports the fallback when the timezone is invalid', async () => {
    service.setTimezone.mockResolvedValue('UTC');
    const { interaction, editReply } = mockInteraction({ timezone: 'Mars/Olympus' });
    await controller.execute([interaction]);
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'Mars/Olympus');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('defaulted to **UTC**') }),
    );
  });

  it('applies enabled, cadence, and timezone together', async () => {
    service.setTimezone.mockResolvedValue('Asia/Tokyo');
    const { interaction } = mockInteraction({ enabled: true, cadence: 'daily', timezone: 'Asia/Tokyo' });
    await controller.execute([interaction]);
    expect(service.toggleCheckIn).toHaveBeenCalledWith('user_1', true);
    expect(service.setCadence).toHaveBeenCalledWith('user_1', 'daily');
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'Asia/Tokyo');
  });
});
