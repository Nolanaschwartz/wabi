// Mock the necord decorators and the heavy service module so this spec loads only the
// controller logic (the real CheckInService pulls in pg-boss/discord.js/the coaching chain).
jest.mock('necord', () => ({
  SlashCommand: () => () => {},
  Context: () => () => {},
  Options: () => () => {},
  BooleanOption: () => () => {},
  StringOption: () => () => {},
}));
jest.mock('../checkin.service', () => ({ CheckInService: jest.fn() }));
jest.mock('@wabi/shared', () => ({ prisma: {} }));

import { CheckInController, CheckinDto } from '../checkin.controller';
import { CheckInService } from '../checkin.service';

function mockInteraction() {
  const editReply = jest.fn().mockResolvedValue({});
  return {
    interaction: {
      deferReply: jest.fn().mockResolvedValue({}),
      editReply,
      user: { id: 'user_1' },
    } as any,
    editReply,
  };
}

// necord resolves absent options to null; the controller normalises null/undefined alike.
function opts(overrides: Partial<CheckinDto> = {}): CheckinDto {
  return { enabled: undefined, cadence: undefined, timezone: undefined, ...overrides };
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
    const { interaction, editReply } = mockInteraction();
    await controller.execute([interaction], opts());
    expect(service.toggleCheckIn).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage') }),
    );
  });

  it('enables check-ins', async () => {
    const { interaction } = mockInteraction();
    await controller.execute([interaction], opts({ enabled: true }));
    expect(service.toggleCheckIn).toHaveBeenCalledWith('user_1', true);
  });

  it('disables check-ins', async () => {
    const { interaction } = mockInteraction();
    await controller.execute([interaction], opts({ enabled: false }));
    expect(service.toggleCheckIn).toHaveBeenCalledWith('user_1', false);
  });

  it('sets a valid cadence', async () => {
    const { interaction, editReply } = mockInteraction();
    await controller.execute([interaction], opts({ cadence: 'weekly' }));
    expect(service.setCadence).toHaveBeenCalledWith('user_1', 'weekly');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('weekly') }),
    );
  });

  it('rejects an invalid cadence without persisting', async () => {
    const { interaction, editReply } = mockInteraction();
    await controller.execute([interaction], opts({ cadence: 'hourly' }));
    expect(service.setCadence).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid cadence') }),
    );
  });

  it('sets a valid timezone', async () => {
    service.setTimezone.mockResolvedValue('America/New_York');
    const { interaction, editReply } = mockInteraction();
    await controller.execute([interaction], opts({ timezone: 'America/New_York' }));
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'America/New_York');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('America/New_York') }),
    );
  });

  it('reports the fallback when the timezone is invalid', async () => {
    service.setTimezone.mockResolvedValue('UTC');
    const { interaction, editReply } = mockInteraction();
    await controller.execute([interaction], opts({ timezone: 'Mars/Olympus' }));
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'Mars/Olympus');
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('defaulted to **UTC**') }),
    );
  });

  it('applies enabled, cadence, and timezone together', async () => {
    service.setTimezone.mockResolvedValue('Asia/Tokyo');
    const { interaction } = mockInteraction();
    await controller.execute([interaction], opts({ enabled: true, cadence: 'daily', timezone: 'Asia/Tokyo' }));
    expect(service.toggleCheckIn).toHaveBeenCalledWith('user_1', true);
    expect(service.setCadence).toHaveBeenCalledWith('user_1', 'daily');
    expect(service.setTimezone).toHaveBeenCalledWith('user_1', 'Asia/Tokyo');
  });
});
