jest.mock('necord', () => ({
  Context: () => () => {},
  Options: () => () => {},
  StringOption: () => () => {},
  Subcommand: () => () => {},
  createCommandGroupDecorator: () => () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
// JournalService transitively imports coach/habit-engagement; stub it. We inject a plain mock.
jest.mock('../journal.service', () => ({ JournalService: class {} }));
// Stub the logger module so its discord.js + crisis/memory imports never load; we inject a mock.
jest.mock('../../inner-state-logger/inner-state-logger.service', () => ({
  InnerStateLoggerService: class {},
}));

import { MessageFlags } from 'discord.js';
import { JournalController } from '../journal.controller';
import { JournalService } from '../journal.service';
import { InnerStateLoggerService } from '../../inner-state-logger/inner-state-logger.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    user: { id: 'user_1' },
  } as any;
}

describe('JournalController', () => {
  let controller: JournalController;
  let journalService: jest.Mocked<JournalService>;
  let logger: jest.Mocked<InnerStateLoggerService>;

  beforeEach(() => {
    journalService = {
      write: jest.fn().mockResolvedValue({ reflection: 'Nice.', xpAwarded: 10 }),
      prompt: jest.fn().mockResolvedValue('Reflect on your day.'),
    } as any;
    logger = { log: jest.fn().mockResolvedValue({ kind: 'logged' }) } as any;
    controller = new JournalController(journalService, logger);
  });

  describe('/journal write — routes through the inner-state logger', () => {
    it('passes the entry content as the screened free text under the "Journal" prefix', async () => {
      await controller.write([mockInteraction()], { content: 'I had a good day today' });

      const write = logger.log.mock.calls[0][0];
      expect(write.freeText).toEqual({ value: 'I had a good day today', derivePrefix: 'Journal' });
    });

    it('validate rejects an entry under 10 characters before any screening or persist', async () => {
      await controller.write([mockInteraction()], { content: 'short' });

      const write = logger.log.mock.calls[0][0];
      expect(write.validate!()).toContain("a bit short");
    });

    it('validate passes for a long-enough entry', async () => {
      await controller.write([mockInteraction()], { content: 'I had a good day today' });

      const write = logger.log.mock.calls[0][0];
      expect(write.validate!()).toBeNull();
    });

    it('persist saves through the journal service and returns the value-typed reflection + XP', async () => {
      await controller.write([mockInteraction()], { content: 'I had a good day today' });

      const write = logger.log.mock.calls[0][0];
      // The recorder hands the writer the Screened proof; forge the minable arm so persist can narrow it.
      const proof = { freeText: 'I had a good day today', derivePrefix: 'Journal' } as any;
      const value = await write.persist(proof);

      expect(journalService.write).toHaveBeenCalledWith('user_1', proof);
      expect(value).toEqual({ reflection: 'Nice.', xpAwarded: 10 });
    });

    it('confirm renders the standalone "Entry saved" copy from the typed value (no cast)', async () => {
      await controller.write([mockInteraction()], { content: 'I had a good day today' });

      const write = logger.log.mock.calls[0][0];
      const text = write.confirm({ reflection: 'Nice.', xpAwarded: 10 });
      expect(text).toBe('Entry saved. Nice. (+10 XP)');
    });
  });

  // /journal prompt writes no inner state, so it keeps its own ephemeral defer.
  it('/journal prompt defers ephemerally and replies with a prompt', async () => {
    const interaction = mockInteraction();
    await controller.prompt([interaction]);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
