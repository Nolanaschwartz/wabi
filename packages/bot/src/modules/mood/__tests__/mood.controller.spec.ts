jest.mock('necord', () => ({
  Context: () => () => {},
  Options: () => () => {},
  IntegerOption: () => () => {},
  NumberOption: () => () => {},
  StringOption: () => () => {},
  SlashCommand: () => () => {},
  Subcommand: () => () => {},
  createCommandGroupDecorator: () => () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('../mood.service', () => ({
  MoodService: class {
    static ratingToEmoji() {
      return '🙂';
    }
    static isLowMood() {
      return false;
    }
  },
}));
// Stub the logger module so its discord.js + crisis/memory imports never load; we inject a mock.
jest.mock('../../inner-state-logger/inner-state-logger.service', () => ({
  InnerStateLoggerService: class {},
}));

import { MoodController, FeelingController } from '../mood.controller';
import { MoodService } from '../mood.service';
import { InnerStateLoggerService } from '../../inner-state-logger/inner-state-logger.service';

function mockInteraction() {
  return { user: { id: 'user_1' } } as any;
}

describe('MoodController — routes through the inner-state logger', () => {
  let controller: MoodController;
  let moodService: jest.Mocked<MoodService>;
  let logger: jest.Mocked<InnerStateLoggerService>;

  beforeEach(() => {
    moodService = {
      create: jest.fn().mockResolvedValue(undefined),
      createNote: jest.fn().mockResolvedValue(undefined),
      trend: jest.fn().mockResolvedValue(0),
    } as any;
    logger = { log: jest.fn().mockResolvedValue({ kind: 'logged' }) } as any;
    controller = new MoodController(moodService, logger);
  });

  it('logs the note as the screened free text under the "Mood note" prefix', async () => {
    await controller.log([mockInteraction()], { rating: 3, note: 'feeling okay' });

    const write = logger.log.mock.calls[0][0];
    expect(write.freeText).toEqual({ value: 'feeling okay', derivePrefix: 'Mood note' });
  });

  it('persist writes the clamped mood and threads the 7-day trend through T (so confirm stays sync)', async () => {
    moodService.trend.mockResolvedValue(3.2);
    await controller.log([mockInteraction()], { rating: 9, note: 'great run' });

    const write = logger.log.mock.calls[0][0];
    // A note is present ⇒ the recorder hands a minable proof; persist routes to the proof-typed writer.
    const note = { freeText: 'great run', derivePrefix: 'Mood note' } as any;
    const value = await write.persist(note);

    // rating clamped to 1..5, emoji from the static, note carried as the Screened proof.
    expect(moodService.createNote).toHaveBeenCalledWith(
      'user_1',
      { rating: 5, emoji: '🙂' },
      note,
    );
    expect(moodService.create).not.toHaveBeenCalled();
    expect(value).toEqual({ trend: 3.2 });
  });

  it('confirm renders the standalone "Mood logged" copy including the trend', async () => {
    await controller.log([mockInteraction()], { rating: 3, note: 'feeling okay' });

    const write = logger.log.mock.calls[0][0];
    const text = write.confirm({ trend: 3.2 });
    expect(text).toContain('Mood logged');
    expect(text).toContain('3.2-day average');
  });
});

describe('FeelingController — rating-only, but never bypasses the logger', () => {
  let controller: FeelingController;
  let moodService: jest.Mocked<MoodService>;
  let logger: jest.Mocked<InnerStateLoggerService>;

  beforeEach(() => {
    moodService = { create: jest.fn().mockResolvedValue(undefined) } as any;
    logger = { log: jest.fn().mockResolvedValue({ kind: 'logged' }) } as any;
    controller = new FeelingController(moodService, logger);
  });

  it('/feeling routes through the logger with NO free text (no screen, no derive, no prompt)', async () => {
    await controller.execute([mockInteraction()], { rating: 4 });

    const write = logger.log.mock.calls[0][0];
    expect(write.freeText).toBeUndefined();

    await write.persist({ freeText: null, derivePrefix: null } as any);
    expect(moodService.create).toHaveBeenCalledWith('user_1', { rating: 4, emoji: '🙂' });
    expect(write.confirm(undefined)).toContain('Logged your mood');
  });

  // FeelingDto.rating is a float NumberOption, so it must be rounded + clamped to 1..5 before it
  // reaches the Int Mood.rating column — otherwise a fractional rating throws on write and the
  // ephemeral defer is never resolved (parity with /mood log's clamp).
  it('rounds a fractional /feeling rating before persisting', async () => {
    await controller.execute([mockInteraction()], { rating: 3.7 });

    const write = logger.log.mock.calls[0][0];
    await write.persist({ freeText: null, derivePrefix: null } as any);
    expect(moodService.create).toHaveBeenCalledWith('user_1', { rating: 4, emoji: '🙂' });
  });

  it('clamps an out-of-range /feeling rating to 1..5 before persisting', async () => {
    await controller.execute([mockInteraction()], { rating: 100 });

    const write = logger.log.mock.calls[0][0];
    await write.persist({ freeText: null, derivePrefix: null } as any);
    expect(moodService.create).toHaveBeenCalledWith('user_1', { rating: 5, emoji: '🙂' });
  });
});
