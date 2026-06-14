jest.mock('@wabi/shared', () => ({ prisma: {} }));
jest.mock('../../memory/inner-state-memory.service', () => ({ InnerStateMemoryService: class {} }));
jest.mock('../../memory/inner-state-consent.service', () => ({ InnerStateConsentService: class {} }));

import { InnerStateRecorderService } from '../inner-state-recorder.service';
import type { Screened } from '../../crisis/screened';

const PROMPT = { content: 'CONSENT_PROMPT', components: ['row'] };

/**
 * The recorder consumes a `Screened` proof minted upstream. Tests forge one directly — minting is the
 * surface adapters' job (slash runs guard, DM converts its verdict) and is covered there.
 */
function screened(freeText: string | null, derivePrefix: string | null = null): Screened {
  return { freeText, derivePrefix } as unknown as Screened;
}

describe('InnerStateRecorderService — the transport-free screened-record tail (ADR-0031)', () => {
  let recorder: InnerStateRecorderService;
  let innerStateMemory: { deriveIfConsented: jest.Mock };
  let consent: { prepareFirstUsePrompt: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) };
    consent = { prepareFirstUsePrompt: jest.fn().mockResolvedValue(PROMPT) };
    recorder = new InnerStateRecorderService(innerStateMemory as any, consent as any);
  });

  it('persists and threads the value through confirm — no discord.js in sight', async () => {
    const persist = jest.fn().mockResolvedValue({ trend: 5 });
    const confirm = jest.fn(({ trend }: { trend: number }) => `avg ${trend}`);

    const outcome = await recorder.record('user_1', screened('feeling okay', 'Mood note'), {
      persist,
      confirm,
    });

    expect(persist).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({ trend: 5 });
    expect(outcome).toEqual({
      kind: 'logged',
      value: { trend: 5 },
      confirmation: 'avg 5',
      consentPrompt: PROMPT,
    });
  });

  it('derives the prefixed screened text when the proof carried minable free text', async () => {
    await recorder.record('user_1', screened('lost ranked again', 'Tilt trigger'), {
      persist: jest.fn().mockResolvedValue({}),
      confirm: () => 'ok',
    });

    expect(innerStateMemory.deriveIfConsented).toHaveBeenCalledWith(
      'user_1',
      'Tilt trigger: lost ranked again',
    );
  });

  it('keeps the derived text equal to the screened free text plus its prefix', async () => {
    await recorder.record('user_1', screened('feeling okay', 'Mood note'), {
      persist: jest.fn().mockResolvedValue({}),
      confirm: () => 'ok',
    });

    const [, derived] = innerStateMemory.deriveIfConsented.mock.calls[0];
    expect(derived).toBe('Mood note: feeling okay');
  });

  it('offers the consent prompt only when the proof carried free text', async () => {
    const outcome = await recorder.record('user_1', screened('a note', 'Mood note'), {
      persist: jest.fn().mockResolvedValue({}),
      confirm: () => 'ok',
    });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalledWith('user_1');
    expect(outcome.consentPrompt).toBe(PROMPT);
  });

  it('structured-only record (freeText null) derives nothing and never asks for consent', async () => {
    const outcome = await recorder.record('user_1', screened(null, null), {
      persist: jest.fn().mockResolvedValue({}),
      confirm: () => 'ok',
    });

    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
    expect(consent.prepareFirstUsePrompt).not.toHaveBeenCalled();
    expect(outcome.consentPrompt).toBeNull();
  });

  it('passes through a null consent prompt (person already asked) without inventing one', async () => {
    consent.prepareFirstUsePrompt.mockResolvedValue(null);

    const outcome = await recorder.record('user_1', screened('a note', 'Mood note'), {
      persist: jest.fn().mockResolvedValue({}),
      confirm: () => 'ok',
    });

    expect(consent.prepareFirstUsePrompt).toHaveBeenCalled();
    expect(outcome.consentPrompt).toBeNull();
  });
});
