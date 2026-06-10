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

import { MoodController } from '../mood.controller';
import { MoodService } from '../mood.service';
import { InnerStateConsentService } from '../../memory/inner-state-consent.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    user: { id: 'user_1' },
  } as any;
}

const PROMPT = { content: 'CONSENT_PROMPT', components: ['row'] };

describe('MoodController — first-use consent prompt', () => {
  let controller: MoodController;
  let moodService: jest.Mocked<MoodService>;
  let consent: jest.Mocked<InnerStateConsentService>;

  beforeEach(() => {
    moodService = {
      log: jest.fn().mockResolvedValue({ crisis: false, value: undefined }),
      trend: jest.fn().mockResolvedValue(0),
    } as any;
    consent = { prepareFirstUsePrompt: jest.fn().mockResolvedValue(PROMPT) } as any;
    controller = new MoodController(moodService, consent);
  });

  it('appends the prompt when the mood carries a free-text note', async () => {
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 3, note: 'feeling okay' });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('CONSENT_PROMPT');
    expect(reply.components).toEqual(['row']);
  });

  it('does NOT offer the prompt for a rating-only mood (no free text used)', async () => {
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 4 });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.components ?? []).toEqual([]);
  });

  it('never offers the prompt on a crisis note', async () => {
    moodService.log.mockResolvedValue({ crisis: true, response: { content: 'resources' } } as any);
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 1, note: 'I want to die' });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
  });
});
