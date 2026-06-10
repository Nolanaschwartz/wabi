jest.mock('necord', () => ({
  SlashCommand: () => () => {},
  Subcommand: () => () => {},
  Button: () => () => {},
  Context: () => () => {},
  Options: () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));

import { MemoryConsentController } from '../memory-consent.controller';
import { InnerStateConsentService } from '../inner-state-consent.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    reply: jest.fn().mockResolvedValue({}),
    user: { id: 'user_1' },
  } as any;
}

describe('MemoryConsentController', () => {
  let controller: MemoryConsentController;
  let consent: jest.Mocked<InnerStateConsentService>;

  beforeEach(() => {
    consent = {
      isEnabled: jest.fn(),
      grant: jest.fn().mockResolvedValue(undefined),
      decline: jest.fn().mockResolvedValue(undefined),
      toggle: jest.fn(),
      buildStatus: jest.fn().mockReturnValue({ content: 'status', components: ['row'] }),
    } as any;
    controller = new MemoryConsentController(consent);
  });

  it('/memory shows current state with a toggle button (ephemeral)', async () => {
    consent.isEnabled.mockResolvedValue(true);
    const interaction = mockInteraction();

    await controller.memory([interaction]);

    expect(interaction.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.anything() }),
    );
    expect(consent.isEnabled).toHaveBeenCalledWith('user_1');
    expect(consent.buildStatus).toHaveBeenCalledWith(true);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'status', components: ['row'] });
  });

  it('[Remember my notes] opts the person in', async () => {
    const interaction = mockInteraction();
    await controller.onRemember([interaction]);
    expect(consent.grant).toHaveBeenCalledWith('user_1');
    expect(interaction.update).toHaveBeenCalled();
  });

  it('[Keep private] records the decline without opting in', async () => {
    const interaction = mockInteraction();
    await controller.onKeepPrivate([interaction]);
    expect(consent.decline).toHaveBeenCalledWith('user_1');
    expect(consent.grant).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
  });

  it('toggle button flips the flag and re-renders the new state', async () => {
    consent.toggle.mockResolvedValue(false);
    const interaction = mockInteraction();

    await controller.onToggle([interaction]);

    expect(consent.toggle).toHaveBeenCalledWith('user_1');
    expect(consent.buildStatus).toHaveBeenCalledWith(false);
    expect(interaction.update).toHaveBeenCalledWith({ content: 'status', components: ['row'] });
  });
});
