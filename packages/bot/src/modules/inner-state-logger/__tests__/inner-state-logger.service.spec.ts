jest.mock('@wabi/shared', () => ({ prisma: {} }));
// The slash adapter only needs the injected services for typing/DI; stub the modules so their
// transitive ESM imports (escalation→pg-boss, Mem0, prisma) never load. We inject plain mocks anyway.
jest.mock('../../crisis/crisis-screening.service', () => ({ CrisisScreeningService: class {} }));
jest.mock('../inner-state-recorder.service', () => ({ InnerStateRecorderService: class {} }));

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
 * Builds a write whose persist/confirm are spies. `freeText` defaults to a minable Mood-note-shaped
 * bundle; override `freeText: undefined` for the structured-only path.
 */
function makeWrite(over: Record<string, unknown> = {}) {
  const interaction = (over.interaction as any) ?? mockInteraction();
  const persist = (over.persist as jest.Mock) ?? jest.fn().mockResolvedValue({ trend: 4 });
  const confirm =
    (over.confirm as jest.Mock) ?? jest.fn((v: any) => `Logged.${v?.trend ? ` trend=${v.trend}` : ''}`);
  const write = {
    interaction,
    freeText:
      'freeText' in over ? (over.freeText as any) : { value: 'feeling okay', derivePrefix: 'Mood note' },
    validate: over.validate as (() => string | null) | undefined,
    persist,
    confirm,
  };
  return { write, interaction, persist, confirm };
}

describe('InnerStateLoggerService — the slash adapter over the screened-record write (ADR-0031)', () => {
  let logger: InnerStateLoggerService;
  let screening: { screenForRecord: jest.Mock };
  let recorder: { record: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: screening clears safe and mints a proof; the recorder logs and returns a confirmation
    // plus the consent prompt. The screen→mint and persist→derive→consent behaviours are covered in
    // crisis-screening.spec and inner-state-recorder.spec; here we only verify the transport wiring.
    screening = {
      screenForRecord: jest
        .fn()
        .mockResolvedValue({ crisis: false, screened: { freeText: 'feeling okay', derivePrefix: 'Mood note' } }),
    };
    recorder = {
      record: jest.fn(async (_id, _screened, write: any) => ({
        kind: 'logged',
        value: await write.persist(),
        confirmation: write.confirm({ trend: 4 }),
        consentPrompt: PROMPT,
      })),
    };
    logger = new InnerStateLoggerService(screening as any, recorder as any);
  });

  it('defers ephemerally as its very first act — before screening runs', async () => {
    const { write, interaction } = makeWrite();

    await logger.log(write);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      screening.screenForRecord.mock.invocationCallOrder[0],
    );
  });

  it('validate() short-circuits before any screening or record', async () => {
    const { write, interaction } = makeWrite({ validate: () => "That's a bit short." });

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'rejected' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "That's a bit short." });
    expect(screening.screenForRecord).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('screens the free text through screenForRecord, passing the bundle as-is', async () => {
    const { write } = makeWrite();

    await logger.log(write);

    expect(screening.screenForRecord).toHaveBeenCalledWith('user_1', {
      value: 'feeling okay',
      derivePrefix: 'Mood note',
    });
  });

  it('renders the crisis response and never records on a crisis verdict', async () => {
    screening.screenForRecord.mockResolvedValue({ crisis: true, response: { content: 'resources' } });
    const { write, interaction } = makeWrite();

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'crisis' });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'resources' });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('records on the safe path and renders the confirmation alone', async () => {
    const { write, interaction } = makeWrite();

    const result = await logger.log(write);

    expect(result).toEqual({ kind: 'logged' });
    expect(recorder.record).toHaveBeenCalledWith(
      'user_1',
      { freeText: 'feeling okay', derivePrefix: 'Mood note' },
      expect.objectContaining({ persist: expect.any(Function), confirm: expect.any(Function) }),
    );
    const reply = interaction.editReply.mock.calls.at(-1)![0];
    expect(reply.content).toBe('Logged. trend=4');
    expect(reply.components ?? []).toEqual([]);
  });

  it('offers the consent prompt on a SEPARATE ephemeral follow-up when the outcome carries one', async () => {
    const { write, interaction } = makeWrite();

    await logger.log(write);

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'CONSENT_PROMPT',
      components: ['row'],
      flags: MessageFlags.Ephemeral,
    });
  });

  it('suppresses the follow-up when the outcome carries no consent prompt', async () => {
    recorder.record.mockResolvedValue({
      kind: 'logged',
      value: { trend: 4 },
      confirmation: 'Logged.',
      consentPrompt: null,
    });
    const { write, interaction } = makeWrite();

    await logger.log(write);

    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('passes the structured-only bundle (freeText undefined) straight through to screening', async () => {
    screening.screenForRecord.mockResolvedValue({
      crisis: false,
      screened: { freeText: null, derivePrefix: null },
    });
    recorder.record.mockResolvedValue({
      kind: 'logged',
      value: undefined,
      confirmation: 'Logged.',
      consentPrompt: null,
    });
    const { write, interaction } = makeWrite({ freeText: undefined });

    await logger.log(write);

    expect(screening.screenForRecord).toHaveBeenCalledWith('user_1', undefined);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
