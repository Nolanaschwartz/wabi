jest.mock('necord', () => ({
  Context: () => () => {},
  Options: () => () => {},
  StringOption: () => () => {},
  Subcommand: () => () => {},
  createCommandGroupDecorator: () => () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
// JournalService transitively imports crisis-screening → escalation → pg-boss (ESM); stub it.
jest.mock('../journal.service', () => ({ JournalService: class {} }));

import { MessageFlags } from 'discord.js';
import { JournalController } from '../journal.controller';
import { JournalService } from '../journal.service';
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

describe('JournalController — first-use consent prompt', () => {
  let controller: JournalController;
  let journalService: jest.Mocked<JournalService>;
  let consent: jest.Mocked<InnerStateConsentService>;

  beforeEach(() => {
    journalService = {
      write: jest.fn().mockResolvedValue({ crisis: false, value: { reflection: 'Nice.', xpAwarded: 10 } }),
      prompt: jest.fn().mockResolvedValue('Reflect on your day.'),
    } as any;
    consent = { prepareFirstUsePrompt: jest.fn() } as any;
    controller = new JournalController(journalService, consent);
  });

  it('offers the consent prompt as a separate ephemeral follow-up, leaving the saved-entry confirmation intact', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(PROMPT as any);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I had a good day today' });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');

    // The confirmation reply carries the saved-entry copy — and neither the prompt text nor its
    // buttons — so answering the prompt later can't edit this message away.
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('Entry saved');
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);

    // The prompt rides on its own ephemeral follow-up message instead.
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not follow up when the person was already asked', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(null);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I had a good day today' });

    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('Entry saved');
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('never offers the prompt on a crisis entry', async () => {
    journalService.write.mockResolvedValue({ crisis: true, response: { content: 'resources' } } as any);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I want to end it all' });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  // Commands register for the hub Guild as well as the DM (command-contexts.ts), so a public reply
  // would broadcast a journal entry to the whole channel. Inner-state never crosses to a social
  // surface (ADR-0002/0017) → both subcommands must defer ephemerally.
  it('/journal write defers ephemerally so a guild-channel entry never leaks', async () => {
    const interaction = mockInteraction();
    await controller.write([interaction], { content: 'I had a good day today' });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('/journal prompt defers ephemerally', async () => {
    const interaction = mockInteraction();
    await controller.prompt([interaction]);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });
});
