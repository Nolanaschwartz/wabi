jest.mock('necord', () => ({
  Context: () => () => {},
  Options: () => () => {},
  IntegerOption: () => () => {},
  StringOption: () => () => {},
  Subcommand: () => () => {},
  createCommandGroupDecorator: () => () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
// TiltService transitively imports crisis-screening → escalation → pg-boss (ESM); stub it.
jest.mock('../tilt.service', () => ({ TiltService: class {} }));

import { MessageFlags } from 'discord.js';
import { TiltController } from '../tilt.controller';
import { TiltService } from '../tilt.service';
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

describe('TiltController — first-use consent prompt', () => {
  let controller: TiltController;
  let tiltService: jest.Mocked<TiltService>;
  let consent: jest.Mocked<InnerStateConsentService>;

  beforeEach(() => {
    tiltService = {
      start: jest.fn().mockResolvedValue({ crisis: false, value: 'Take a breath.' }),
    } as any;
    consent = { prepareFirstUsePrompt: jest.fn().mockResolvedValue(PROMPT) } as any;
    controller = new TiltController(tiltService, consent);
  });

  it('offers the prompt as a separate ephemeral follow-up when the start carries a free-text trigger', async () => {
    const interaction = mockInteraction();

    await controller.start([interaction], { trigger: 'lost ranked again', severity: 7 });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');

    // The session confirmation stands alone — no prompt copy, no buttons to erase it.
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toContain('Tilt session started');
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does NOT offer the prompt for a severity-only start (no free text used)', async () => {
    const interaction = mockInteraction();

    await controller.start([interaction], { severity: 8 });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.components ?? []).toEqual([]);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('never offers the prompt on a crisis trigger', async () => {
    tiltService.start.mockResolvedValue({ crisis: true, response: { content: 'resources' } } as any);
    const interaction = mockInteraction();

    await controller.start([interaction], { trigger: 'I want to end it all', severity: 9 });

    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
