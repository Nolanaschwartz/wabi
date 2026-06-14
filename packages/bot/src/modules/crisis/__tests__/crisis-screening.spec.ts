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
