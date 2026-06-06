import { CrisisScreeningService } from '../crisis-screening.service';

describe('CrisisScreeningService.tripwire', () => {
  let service: CrisisScreeningService;

  beforeEach(() => {
    service = new CrisisScreeningService();
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
