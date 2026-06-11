jest.mock('@wabi/shared', () => ({ prisma: {} }));
// The logger only needs the injected services for typing/DI; stub the modules so their transitive
// ESM imports (escalation→pg-boss, Mem0, prisma) never load. We inject plain mocks anyway.
jest.mock('../../crisis/crisis-screening.service', () => ({ CrisisScreeningService: class {} }));
jest.mock('../../memory/inner-state-memory.service', () => ({ InnerStateMemoryService: class {} }));
jest.mock('../../memory/inner-state-consent.service', () => ({ InnerStateConsentService: class {} }));

import { MessageFlags } from 'discord.js';
import { InnerStateLoggerService } from '../inner-state-logger.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
    user: { id: 'user_1' },
  } as any;
}

const PROMPT = { content: 'CONSENT_PROMPT', components: ['row'] };

/**
 * Builds a write whose persist/confirm are spies so each test can assert what ran. `freeText`
 * defaults to a minable Mood-note-shaped bundle ({ value, derivePrefix }); override
 * `freeText: undefined` for the structured-only path.
 */
function makeWrite(over: Record<string, unknown> = {}) {
  const interaction = (over.interaction as any) ?? mockInteraction();
  const persist = (over.persist as jest.Mock) ?? jest.fn().mockResolvedValue({ trend: 4 });
  const confirm =
    (over.confirm as jest.Mock) ?? jest.fn((v: any) => `Logged.${v?.trend ? ` trend=${v.trend}` : ''}`);
  const write = {
    interaction,
    freeText: 'freeText' in over ? (over.freeText as any) : { value: 'feeling okay', derivePrefix: 'Mood note' },
    validate: over.validate as (() => string | null) | undefined,
    persist,
    confirm,
  };
  return { write, interaction, persist, confirm };
}

describe('InnerStateLoggerService — the screened-record write path (ADR-0028/0029)', () => {
  let logger: InnerStateLoggerService;
  let screening: { guard: jest.Mock };
  let innerStateMemory: { deriveIfConsented: jest.Mock };
  let consent: { prepareFirstUsePrompt: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: guard screens safe and runs the persist closure. The screen→escalate behaviour itself
    // is covered in crisis-screening.spec; here we only verify the logger routes through the seam.
    screening = {
      guard: jest.fn(async (_id, _content, persist) => ({ crisis: false, value: await persist() })),
    };
    innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) };
    consent = { prepareFirstUsePrompt: jest.fn().mockResolvedValue(PROMPT) };
    logger = new InnerStateLoggerService(screening as any, innerStateMemory as any, consent as any);
  });

  it('defers ephemerally as its very first act — before persist runs', async () => {
    const { write, interaction, persist } = makeWrite();

    await logger.log(write);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      persist.mock.invocationCallOrder[0],
    );
  });

  it('screens the free text through guard before persisting on the safe path', async () => {
    const { write, persist } = makeWrite();

    await logger.log(write);

    expect(screening.guard).toHaveBeenCalledWith('user_1', 'feeling okay', expect.any(Function));
    expect(persist).toHaveBeenCalled();
  });

  it('never persists, derives, confirms, or prompts on a crisis verdict', async () => {
    screening.guard.mockResolvedValue({ crisis: true, response: { content: 'resources' } });
    const { write, interaction, persist, confirm } = makeWrite();

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'crisis' });
    expect(persist).not.toHaveBeenCalled();
    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'resources' });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('derives the prefixed free text inside the guard closure on the safe path', async () => {
    const { write } = makeWrite();

    await logger.log(write);

    expect(innerStateMemory.deriveIfConsented).toHaveBeenCalledWith('user_1', 'Mood note: feeling okay');
  });

  it('keeps the screened text identical to the derived text minus its prefix', async () => {
    const { write } = makeWrite({ freeText: { value: 'lost ranked again', derivePrefix: 'Tilt trigger' } });

    await logger.log(write);

    const screened = screening.guard.mock.calls[0][1];
    const derived = innerStateMemory.deriveIfConsented.mock.calls[0][1];
    expect(derived).toBe(`Tilt trigger: ${screened}`);
  });

  it('persists a structured-only record (no free text) but derives nothing and never prompts', async () => {
    const { write, interaction, persist } = makeWrite({ freeText: undefined });

    await logger.log(write);

    expect(persist).toHaveBeenCalled();
    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('gates BOTH derive and the prompt on the same minable flag — whitespace-only text mines nothing', async () => {
    const { write, interaction } = makeWrite({ freeText: { value: '   ', derivePrefix: 'Mood note' } });

    await logger.log(write);

    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('offers the consent prompt on a SEPARATE ephemeral follow-up when the record carried free text', async () => {
    const { write, interaction } = makeWrite();

    await logger.log(write);

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
      flags: MessageFlags.Ephemeral,
    });
  });

  it('renders the confirmation alone — no prompt copy, no buttons to erase it', async () => {
    const { write, interaction } = makeWrite();

    await logger.log(write);

    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toBe('Logged. trend=4');
    expect(reply.content).not.toContain('CONSENT_PROMPT');
    expect(reply.components ?? []).toEqual([]);
  });

  it('suppresses the follow-up when the person was already asked (prompt is null)', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(null);
    const { write, interaction } = makeWrite();

    await logger.log(write);

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('threads the persist result through to confirm (T carries mood\'s awaited trend)', async () => {
    const persist = jest.fn().mockResolvedValue({ trend: 5 });
    const confirm = jest.fn(({ trend }: { trend: number }) => `avg ${trend}`);
    const { write, interaction } = makeWrite({ persist, confirm });

    await logger.log(write);

    expect(confirm).toHaveBeenCalledWith({ trend: 5 });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'avg 5' });
  });

  it('returns { kind: "logged" } on a safe write', async () => {
    const result = await logger.log(makeWrite().write);
    expect(result).toEqual({ kind: 'logged' });
  });

  it('validate() short-circuits before any screening, persist, derive, or prompt', async () => {
    const persist = jest.fn();
    const { write, interaction } = makeWrite({ validate: () => 'That\'s a bit short.', persist });

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'rejected' });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "That's a bit short." });
    expect(screening.guard).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('proceeds normally when validate() returns null', async () => {
    const { write, persist } = makeWrite({ validate: () => null });

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'logged' });
    expect(persist).toHaveBeenCalled();
  });
});
