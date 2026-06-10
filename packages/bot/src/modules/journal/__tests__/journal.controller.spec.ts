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

import { JournalController } from '../journal.controller';
import { JournalService } from '../journal.service';
import { InnerStateConsentService } from '../../memory/inner-state-consent.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
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
    } as any;
    consent = { prepareFirstUsePrompt: jest.fn() } as any;
    controller = new JournalController(journalService, consent);
  });

  it('appends the consent prompt to a saved entry when the person has not been asked', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(PROMPT as any);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I had a good day today' });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('CONSENT_PROMPT');
    expect(reply.components).toEqual(['row']);
  });

  it('does not append a prompt (no components) when the person was already asked', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(null);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I had a good day today' });

    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);
  });

  it('never offers the prompt on a crisis entry', async () => {
    journalService.write.mockResolvedValue({ crisis: true, response: { content: 'resources' } } as any);
    const interaction = mockInteraction();

    await controller.write([interaction], { content: 'I want to end it all' });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
  });
});
