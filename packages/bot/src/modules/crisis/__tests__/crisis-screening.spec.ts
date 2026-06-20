// screen() pulls in EscalationService → CrisisAftermathService → SchedulerService → pg-boss, which
// is ESM and breaks the Jest loader. We inject mock collaborators, so stub the transitive deps to
// keep the import graph parseable (same pattern as escalation.service.spec).
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    createQueue: jest.fn(),
    work: jest.fn(),
    schedule: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('@wabi/shared', () => ({
  prisma: {},
}));

import { CrisisScreeningService } from '../crisis-screening.service';

const noopDeps = () =>
  [{ classify: jest.fn() }, { escalate: jest.fn() }] as const;

describe('CrisisScreeningService.tripwire', () => {
  let service: CrisisScreeningService;

  beforeEach(() => {
    const [classifier, escalation] = noopDeps();
    service = new CrisisScreeningService(classifier as any, escalation as any);
  });

  describe('explicit crisis phrases → true', () => {
    const explicitPhrases = [
      'I want to die',
      'I don\'t want to live anymore',
      'I\'m going to kill myself',
      'I want to end this',
      'I wish I were dead',
      'I can\'t go on like this',
      'I\'m better off dead',
      'there\'s no point anymore',
      'I want to go to sleep and never wake up',
      'I have a plan to kill myself',
    ];

    it.each(explicitPhrases)('should fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(true);
    });
  });

  describe('gamer hyperbole → false', () => {
    const gamerPhrases = [
      'kys',
      'this boss wants me dead',
      'I give up on this level',
      'I\'m so bad at this',
      'this is killing me',
      'I\'m dying of laughter',
      'I\'m dead inside',
      'my team is throwing',
      'I want to rage quit',
      'I\'m so fed up with this',
    ];

    it.each(gamerPhrases)('should NOT fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(false);
    });
  });

  describe('normal conversation → false', () => {
    const normalPhrases = [
      'How are you today?',
      'I had a great day at work',
      'I\'m feeling anxious about the weather',
      'Can you help me with something?',
      'I need some advice on my skincare routine',
    ];

    it.each(normalPhrases)('should NOT fire on: "%s"', (phrase) => {
      expect(service.tripwire(phrase)).toBe(false);
    });
  });
});

describe('CrisisScreeningService.screen', () => {
  let service: CrisisScreeningService;
  let classifier: { classify: jest.Mock };
  let escalation: { escalate: jest.Mock };
  const payload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    classifier = { classify: jest.fn() };
    escalation = { escalate: jest.fn().mockResolvedValue(payload) };
    service = new CrisisScreeningService(classifier as any, escalation as any);
  });

  it('escalates on a tripwire hit without running the classifier (cheap layer first)', async () => {
    const verdict = await service.screen('123', 'I want to die');

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'tripwire', 'field');
    expect(verdict).toEqual({ kind: 'crisis', response: payload });
  });

  it('escalates on a classifier crisis when the tripwire misses', async () => {
    classifier.classify.mockResolvedValue('crisis');

    const verdict = await service.screen('123', "i just don't see the point in any of it");

    expect(classifier.classify).toHaveBeenCalledWith(
      "i just don't see the point in any of it",
    );
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier', 'field');
    expect(verdict).toEqual({ kind: 'crisis', response: payload });
  });

  it('returns safe and never escalates when both layers clear', async () => {
    classifier.classify.mockResolvedValue('safe');

    const verdict = await service.screen('123', 'I had a good day today');

    expect(escalation.escalate).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'safe' });
  });
});

describe('CrisisScreeningService.guard — the shared screened-record path', () => {
  let service: CrisisScreeningService;
  let classifier: { classify: jest.Mock };
  let escalation: { escalate: jest.Mock };
  const payload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    classifier = { classify: jest.fn().mockResolvedValue('safe') };
    escalation = { escalate: jest.fn().mockResolvedValue(payload) };
    service = new CrisisScreeningService(classifier as any, escalation as any);
  });

  it('runs the persist and returns its value when the free text clears', async () => {
    const persist = jest.fn().mockResolvedValue({ id: 'm1' });

    const result = await service.guard('123', 'I had a good day', persist);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ crisis: false, value: { id: 'm1' } });
  });

  it('short-circuits to the crisis response and NEVER persists on a crisis hit', async () => {
    const persist = jest.fn().mockResolvedValue({ id: 'm1' });

    const result = await service.guard('123', 'I want to die', persist);

    expect(persist).not.toHaveBeenCalled();
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'tripwire', 'field');
    expect(result).toEqual({ crisis: true, response: payload });
  });

  it('skips screening for absent/empty free text (structured-only record)', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);

    const result = await service.guard('123', undefined, persist);

    expect(escalation.escalate).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ crisis: false, value: undefined });
  });
});

describe('CrisisScreeningService.screenForRecord — the slash mint site (ADR-0031)', () => {
  let service: CrisisScreeningService;
  let classifier: { classify: jest.Mock };
  let escalation: { escalate: jest.Mock };
  const payload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    classifier = { classify: jest.fn().mockResolvedValue('safe') };
    escalation = { escalate: jest.fn().mockResolvedValue(payload) };
    service = new CrisisScreeningService(classifier as any, escalation as any);
  });

  it('mints a proof carrying the exact screened text and prefix when the field clears', async () => {
    const result = await service.screenForRecord('123', {
      value: 'I had a good day',
      derivePrefix: 'Mood note',
    });

    expect(result).toEqual({
      crisis: false,
      screened: { freeText: 'I had a good day', derivePrefix: 'Mood note' },
    });
  });

  it('returns a crisis without a proof and never mints on a crisis hit', async () => {
    const result = await service.screenForRecord('123', {
      value: 'I want to die',
      derivePrefix: 'Journal',
    });

    expect(escalation.escalate).toHaveBeenCalledWith('123', 'tripwire', 'field');
    expect(result).toEqual({ crisis: true, response: payload });
    expect((result as any).screened).toBeUndefined();
  });

  it('mints a null-free-text proof for a structured-only record (no field)', async () => {
    const result = await service.screenForRecord('123');

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(escalation.escalate).not.toHaveBeenCalled();
    expect(result).toEqual({ crisis: false, screened: { freeText: null, derivePrefix: null } });
  });

  it('mints a null-free-text proof for whitespace-only free text (mines nothing)', async () => {
    const result = await service.screenForRecord('123', { value: '   ', derivePrefix: 'Mood note' });

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(result).toEqual({ crisis: false, screened: { freeText: null, derivePrefix: null } });
  });
});

describe('CrisisScreeningService.screenedFromUpstream — the DM mint site (ADR-0031)', () => {
  let service: CrisisScreeningService;

  beforeEach(() => {
    const classifier = { classify: jest.fn().mockResolvedValue('safe') };
    const escalation = { escalate: jest.fn() };
    service = new CrisisScreeningService(classifier as any, escalation as any);
  });

  it('mints a batch proof carrying the exact screened text', () => {
    expect(service.screenedBatch('had a rough night')).toEqual({ text: 'had a rough night' });
  });

  it('fromBatch vouches with a proof carrying the exact text + prefix when persisted text IS the batch (no re-screen)', () => {
    const batch = service.screenedBatch('had a rough night');
    expect(service.fromBatch(batch, 'had a rough night', 'Journal')).toEqual({
      freeText: 'had a rough night',
      derivePrefix: 'Journal',
    });
  });

  it('fromBatch refuses (null) when the persisted text is NOT the screened batch — caller must re-screen', () => {
    const batch = service.screenedBatch('had a rough night');
    expect(service.fromBatch(batch, 'a transformed, different entry', 'Journal')).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t '],
  ])('fromBatch normalises blank batch text (%s) to the structured-only shape — never freeText with a dangling prefix', (_label, blank) => {
    // The single mint forge collapses blank text to { null, null }, so the mint can never produce
    // the unrepresentable "prefix without minable text" state, even from a blank batch.
    const batch = service.screenedBatch(blank);
    expect(service.fromBatch(batch, blank, 'Journal')).toEqual({ freeText: null, derivePrefix: null });
  });
});
