// The handler imports CrisisScreeningService (→ escalation → pg-boss ESM) and InnerStateRecorderService
// (→ memory → prisma) for DI typing only; we inject plain mocks. Stub the modules so their transitive
// imports never load under Jest (same pattern as inner-state-logger.service.spec).
jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('../../crisis/crisis-screening.service', () => ({ CrisisScreeningService: class {} }));
jest.mock('../../inner-state-logger/inner-state-recorder.service', () => ({ InnerStateRecorderService: class {} }));

import { JournalDmHandler } from '../journal-dm.handler';
import { JournalService } from '../journal.service';
import { SpokeSessionService } from '../../spoke-session/spoke-session.service';
import { CrisisScreeningService } from '../../crisis/crisis-screening.service';
import { InnerStateRecorderService } from '../../inner-state-logger/inner-state-recorder.service';
import type { DmTurnContext } from '../../coaching/coach-handler';

const CONSENT_PROMPT = { content: 'CONSENT_PROMPT', components: ['row'] };

describe('JournalDmHandler', () => {
  let handler: JournalDmHandler;
  let journalService: { write: jest.Mock; prompt: jest.Mock; latestEntry: jest.Mock };
  let screening: { fromBatch: jest.Mock; screenForRecord: jest.Mock };
  let recorder: { record: jest.Mock };
  let spokeSession: { setActive: jest.Mock; consume: jest.Mock };

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'journal: had a rough night', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'journal: had a rough night',
    screenedBatch: { text: 'journal: had a rough night' } as any,
    session: null,
    strategies: [],
    memories: [],
    memoryLatencyMs: 0,
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    journalService = {
      write: jest.fn().mockResolvedValue({ reflection: 'That sounds heavy — glad you wrote it down.', xpAwarded: 10 }),
      prompt: jest.fn().mockResolvedValue("What's weighing on your mind right now?"),
      latestEntry: jest.fn().mockResolvedValue(null),
    };
    // The DM surface mints a proof from the verdict the upstream classifier already produced this turn,
    // then runs the SAME transport-free tail as the slash path. We forge the proof + outcome here; the
    // mint and the persist→derive→consent tail are covered in crisis-screening.spec / recorder.spec.
    screening = {
      // Default: the persisted text IS the screened batch, so fromBatch vouches without re-screening.
      fromBatch: jest.fn((_batch: unknown, content: string, prefix: string) => ({ freeText: content, derivePrefix: prefix })),
      screenForRecord: jest.fn(),
    };
    recorder = {
      record: jest.fn(async (_id, screened, write: any) => ({
        kind: 'logged',
        // The real recorder hands the writer the Screened proof; mirror that so the persist closure can
        // narrow it to ScreenedText and pass it to JournalService.write (ADR-0031).
        value: await write.persist(screened),
        confirmation: write.confirm({ reflection: 'That sounds heavy — glad you wrote it down.', xpAwarded: 10 }),
        consentPrompt: CONSENT_PROMPT,
      })),
    };
    spokeSession = {
      setActive: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue('journal'),
    };
    handler = new JournalDmHandler(
      journalService as unknown as JournalService,
      screening as unknown as CrisisScreeningService,
      recorder as unknown as InnerStateRecorderService,
      spokeSession as unknown as SpokeSessionService,
    );
  });

  it('persists the entry through the shared JournalService.write (one writer, no duplicated logic)', async () => {
    await handler.handle(ctx(), 'had a rough ranked night, feel worthless at the game');

    expect(journalService.write).toHaveBeenCalledWith(
      '123',
      expect.objectContaining({ freeText: 'had a rough ranked night, feel worthless at the game' }),
    );
  });

  it('mints the proof from the batch verdict (no re-screen) and records through the shared tail', async () => {
    await handler.handle(ctx(), 'had a rough ranked night, feel worthless at the game');

    expect(screening.fromBatch).toHaveBeenCalledWith(
      expect.anything(),
      'had a rough ranked night, feel worthless at the game',
      'Journal',
    );
    expect(screening.screenForRecord).not.toHaveBeenCalled(); // no re-screen on the verbatim path
    expect(recorder.record).toHaveBeenCalledWith(
      '123',
      { freeText: 'had a rough ranked night, feel worthless at the game', derivePrefix: 'Journal' },
      expect.objectContaining({ persist: expect.any(Function), confirm: expect.any(Function) }),
    );
  });

  it('fails SAFE when the batch proof refuses (text ≠ batch): re-screens via screenForRecord, then records on safe', async () => {
    screening.fromBatch.mockReturnValueOnce(null); // persisted text is not the screened batch
    screening.screenForRecord.mockResolvedValueOnce({ crisis: false, screened: { freeText: 'transformed entry', derivePrefix: 'Journal' } });

    await handler.handle(ctx(), 'transformed entry');

    expect(screening.screenForRecord).toHaveBeenCalledWith('123', { value: 'transformed entry', derivePrefix: 'Journal' });
    expect(recorder.record).toHaveBeenCalled();
  });

  it('fails SAFE when the batch proof refuses AND the re-screen catches a crisis: renders the response, never records', async () => {
    screening.fromBatch.mockReturnValueOnce(null);
    screening.screenForRecord.mockResolvedValueOnce({ crisis: true, response: 'CRISIS_RESOURCES' });
    const c = ctx();

    await handler.handle(c, 'transformed entry that screens as crisis');

    expect(c.message.reply).toHaveBeenCalledWith('CRISIS_RESOURCES');
    expect(recorder.record).not.toHaveBeenCalled();
    expect(journalService.write).not.toHaveBeenCalled();
  });

  it('sends the same "Entry saved" confirmation copy as the slash path, with the awarded XP', async () => {
    const c = ctx();

    await handler.handle(c, 'had a rough ranked night');

    expect(c.message.reply).toHaveBeenCalledWith(
      'Entry saved. That sounds heavy — glad you wrote it down. (+10 XP)',
    );
  });

  it('fires the first-use consent prompt on the DM journal path (the closed gap, ADR-0031)', async () => {
    const c = ctx();

    await handler.handle(c, 'had a rough ranked night');

    expect(c.message.reply).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
    });
    // Confirmation first, then the consent prompt as a separate message.
    const order = (c.message.reply as jest.Mock).mock.calls.map((args) => args[0]);
    expect(order[0]).toContain('Entry saved.');
  });

  it.each([
    ['empty (attachment/sticker-only DM)', ''],
    ['whitespace only', '   \n\t  '],
  ])('refuses to journal blank content (%s): nudges, never persists/screens/records', async (_label, blank) => {
    const c = ctx();

    await handler.handle(c, blank);

    // No empty entry written, no proof minted, no spurious derive/consent over a non-entry.
    expect(journalService.write).not.toHaveBeenCalled();
    expect(screening.fromBatch).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(c.message.reply).toHaveBeenCalledTimes(1);
    expect(c.message.reply).toHaveBeenCalledWith(expect.stringMatching(/nothing to save/i));
  });

  it('does not send a consent prompt when none is owed (person already asked)', async () => {
    recorder.record.mockResolvedValue({
      kind: 'logged',
      value: { reflection: 'r', xpAwarded: 1 },
      confirmation: 'Entry saved. r (+1 XP)',
      consentPrompt: null,
    });
    const c = ctx();

    await handler.handle(c, 'had a rough ranked night');

    expect(c.message.reply).toHaveBeenCalledTimes(1);
    expect(c.message.reply).toHaveBeenCalledWith('Entry saved. r (+1 XP)');
  });

  describe('Spoke interface (invoke / resume)', () => {
    it('exposes save_entry (active), give_prompt (active), get_entry (any) as its tools', () => {
      expect(handler.intent).toBe('journal');
      expect(handler.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'save_entry', access: 'active' }),
          expect.objectContaining({ name: 'give_prompt', access: 'active' }),
          expect.objectContaining({ name: 'get_entry', access: 'any' }),
        ]),
      );
    });

    it('invoke(save_entry) writes the whole batch verbatim and reports handled', async () => {
      const c = ctx({ batch: 'had a rough ranked night' });

      const result = await handler.invoke('save_entry', c);

      expect(journalService.write).toHaveBeenCalledWith(
        '123',
        expect.objectContaining({ freeText: 'had a rough ranked night' }),
      );
      expect(result).toEqual({ kind: 'handled' });
    });

    it('invoke(get_entry) reads back and reports handled (no write, no floor)', async () => {
      const result = await handler.invoke('get_entry', ctx());

      expect(journalService.latestEntry).toHaveBeenCalledWith('123');
      expect(journalService.write).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    it('invoke(give_prompt) arms the floor and prompts, writing nothing', async () => {
      const result = await handler.invoke('give_prompt', ctx());

      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'journal');
      expect(journalService.write).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    it('invoke(unknown tool) falls to the safe default (give_prompt) and never saves on a guess', async () => {
      const result = await handler.invoke('nonsense', ctx());

      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'journal');
      expect(journalService.write).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    it('resume() consumes the floor and writes the turn verbatim when the floor is claimed', async () => {
      spokeSession.consume.mockResolvedValue('journal');
      const c = ctx({ batch: 'today i felt ok for once' });

      const result = await handler.resume(c);

      expect(spokeSession.consume).toHaveBeenCalledWith('123');
      expect(journalService.write).toHaveBeenCalledWith(
        '123',
        expect.objectContaining({ freeText: 'today i felt ok for once' }),
      );
      expect(result).toEqual({ kind: 'handled' });
    });

    it('resume() falls through (no write) when the floor expired', async () => {
      spokeSession.consume.mockResolvedValue(null);

      const result = await handler.resume(ctx());

      expect(journalService.write).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'fallthrough' });
    });
  });

  describe('beginConversation (bare intent, two-turn)', () => {
    it('arms the pending capture and sends a reflective prompt', async () => {
      const c = ctx({ batch: 'i want to journal' });

      await handler.beginConversation(c);

      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'journal');
      expect(c.message.reply).toHaveBeenCalledWith(
        expect.stringContaining("What's weighing on your mind right now?"),
      );
      // No entry is written on the bare turn — the entry is the NEXT message.
      expect(journalService.write).not.toHaveBeenCalled();
    });
  });

  describe('getEntry (read-back, get_entry tool)', () => {
    it('reads back the latest entry without writing or arming the floor', async () => {
      journalService.latestEntry.mockResolvedValue({
        content: 'lost five ranked games and felt hopeless',
        reflection: 'glad you named it',
        createdAt: new Date('2026-06-13T20:00:00Z'),
      });
      const c = ctx();

      await handler.getEntry(c);

      expect(journalService.latestEntry).toHaveBeenCalledWith('123');
      expect(c.message.reply).toHaveBeenCalledWith(
        expect.stringContaining('lost five ranked games and felt hopeless'),
      );
      // A pure read — never writes, never arms the spoke floor.
      expect(journalService.write).not.toHaveBeenCalled();
      expect(spokeSession.setActive).not.toHaveBeenCalled();
    });

    it('replies gracefully when there is no entry to read back (not an error)', async () => {
      journalService.latestEntry.mockResolvedValue(null);
      const c = ctx();

      await handler.getEntry(c);

      expect(c.message.reply).toHaveBeenCalledWith(expect.stringMatching(/haven't|no .*journal|nothing/i));
      expect(journalService.write).not.toHaveBeenCalled();
    });
  });
});
