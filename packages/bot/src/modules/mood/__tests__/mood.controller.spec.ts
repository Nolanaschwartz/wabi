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

import { MessageFlags } from 'discord.js';
import { MoodController } from '../mood.controller';
import { MoodService } from '../mood.service';
import { InnerStateConsentService } from '../../memory/inner-state-consent.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
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

  it('offers the prompt as a separate ephemeral follow-up when the mood carries a free-text note', async () => {
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 3, note: 'feeling okay' });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');

    // The mood confirmation stands alone — no prompt copy, no buttons to erase it.
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('Mood logged');
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does NOT offer the prompt for a rating-only mood (no free text used)', async () => {
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 4 });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.components ?? []).toEqual([]);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('never offers the prompt on a crisis note', async () => {
    moodService.log.mockResolvedValue({ crisis: true, response: { content: 'resources' } } as any);
    const interaction = mockInteraction();

    await controller.log([interaction], { rating: 1, note: 'I want to die' });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  // /mood log registers for the hub Guild too (command-contexts.ts); a public reply would broadcast
  // the person's mood to the channel. Inner-state never crosses to a social surface (ADR-0002/0017).
  it('/mood log defers ephemerally so a guild-channel mood never leaks', async () => {
    const interaction = mockInteraction();
    await controller.log([interaction], { rating: 4 });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });
});
