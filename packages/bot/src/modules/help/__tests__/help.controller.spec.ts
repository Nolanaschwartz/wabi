// Mock the necord decorators so this spec loads only the controller logic.
jest.mock('necord', () => ({
  SlashCommand: () => () => {},
  Context: () => () => {},
}));

import { HelpController, COMMAND_HELP, renderHelp } from '../help.controller';

function mockInteraction() {
  const reply = jest.fn().mockResolvedValue({});
  return {
    interaction: {
      reply,
      user: { id: 'user_1' },
    } as any,
    reply,
  };
}

describe('renderHelp', () => {
  it('lists every command name and description', () => {
    const text = renderHelp();
    for (const command of COMMAND_HELP) {
      expect(text).toContain(`/${command.name}`);
      expect(text).toContain(command.description);
    }
  });

  it('includes a usage example for every command', () => {
    const text = renderHelp();
    for (const command of COMMAND_HELP) {
      for (const usage of command.usage) {
        expect(text).toContain(usage);
      }
    }
  });

  it('includes itself so users can re-run it', () => {
    expect(COMMAND_HELP.some((c) => c.name === 'help')).toBe(true);
  });
});

describe('HelpController', () => {
  let controller: HelpController;

  beforeEach(() => {
    controller = new HelpController();
  });

  it('replies ephemerally with the rendered help', async () => {
    const { interaction, reply } = mockInteraction();
    await controller.execute([interaction]);
    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0][0];
    expect(arg.content).toContain('/mood');
    expect(typeof arg.flags).not.toBe('undefined');
  });
});
