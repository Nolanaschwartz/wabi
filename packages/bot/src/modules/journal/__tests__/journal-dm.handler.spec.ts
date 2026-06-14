import { JournalDmHandler } from '../journal-dm.handler';
import { JournalService } from '../journal.service';
import { JournalSessionService } from '../journal-session.service';
import { InnerStateMemoryService } from '../../memory/inner-state-memory.service';
import type { DmTurnContext } from '../../coaching/coach-handler';

describe('JournalDmHandler', () => {
  let handler: JournalDmHandler;
  let journalService: { write: jest.Mock; prompt: jest.Mock };
  let innerStateMemory: { deriveIfConsented: jest.Mock };
  let journalSession: { setPending: jest.Mock };

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'journal: had a rough night', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'journal: had a rough night',
    session: null,
    strategies: [],
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    journalService = {
      write: jest.fn().mockResolvedValue({ reflection: 'That sounds heavy — glad you wrote it down.', xpAwarded: 10 }),
      prompt: jest.fn().mockResolvedValue("What's weighing on your mind right now?"),
    };
    innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) };
    journalSession = { setPending: jest.fn().mockResolvedValue(undefined) };
    handler = new JournalDmHandler(
      journalService as unknown as JournalService,
      innerStateMemory as unknown as InnerStateMemoryService,
      journalSession as unknown as JournalSessionService,
    );
  });

  it('persists the entry through the shared JournalService.write (one writer, no duplicated logic)', async () => {
    await handler.handle(ctx(), 'had a rough ranked night, feel worthless at the game');

    expect(journalService.write).toHaveBeenCalledWith(
      '123',
      'had a rough ranked night, feel worthless at the game',
    );
  });

  it('derives memory with the "Journal:" prefix for parity with the slash path', async () => {
    await handler.handle(ctx(), 'had a rough ranked night, feel worthless at the game');

    expect(innerStateMemory.deriveIfConsented).toHaveBeenCalledWith(
      '123',
      'Journal: had a rough ranked night, feel worthless at the game',
    );
  });

  it('sends the same "Entry saved" confirmation copy as the slash path, with the awarded XP', async () => {
    const c = ctx();

    await handler.handle(c, 'had a rough ranked night');

    expect(c.message.reply).toHaveBeenCalledWith(
      'Entry saved. That sounds heavy — glad you wrote it down. (+10 XP)',
    );
  });

  it('does not block the reply on memory derivation (fire-and-forget)', async () => {
    // deriveIfConsented never resolves — the handler must still persist and confirm.
    innerStateMemory.deriveIfConsented.mockReturnValue(new Promise<void>(() => {}));
    const c = ctx();

    await handler.handle(c, 'had a rough ranked night');

    expect(journalService.write).toHaveBeenCalled();
    expect(c.message.reply).toHaveBeenCalledWith(expect.stringContaining('Entry saved.'));
  });

  describe('beginConversation (bare intent, two-turn)', () => {
    it('arms the pending capture and sends a reflective prompt', async () => {
      const c = ctx({ batch: 'i want to journal' });

      await handler.beginConversation(c);

      expect(journalSession.setPending).toHaveBeenCalledWith('123');
      expect(c.message.reply).toHaveBeenCalledWith(
        expect.stringContaining("What's weighing on your mind right now?"),
      );
      // No entry is written on the bare turn — the entry is the NEXT message.
      expect(journalService.write).not.toHaveBeenCalled();
    });
  });
});
