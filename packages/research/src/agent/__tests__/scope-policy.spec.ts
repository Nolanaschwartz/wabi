import { SCOPE_FRAGMENT, prescreen } from '../scope-policy';

describe('scope-policy', () => {
  it('exposes a non-empty scope fragment for prompts to share', () => {
    expect(SCOPE_FRAGMENT.length).toBeGreaterThan(0);
  });

  describe('prescreen (pure, no LLM)', () => {
    it.each([
      'Vitamin D supplementation improved mood in deficient adults.',
      'Daily omega-3 supplements reduced depressive symptoms.',
      'Melatonin 3 mg before bed shortened sleep onset.',
      'Repetitive transcranial magnetic stimulation reduced rumination.',
      'An SSRI was compared against placebo over eight weeks.',
      'Creatine dosing improved cognitive fatigue.',
    ])('rejects clearly out-of-scope text: %s', (t) => {
      expect(prescreen(t)).toBe(false);
    });

    it.each([
      'Emotion regulation reduced tilt in competitive players.',
      'A consistent wind-down routine improved sleep onset.',
      'Cognitive reappraisal lowered self-reported stress.',
      'Avoiding screens before bed improved subjective sleep quality.',
    ])('keeps clearly behavioral text: %s', (t) => {
      expect(prescreen(t)).toBe(true);
    });

    it('keeps ambiguous text (conservative, fail-open)', () => {
      expect(prescreen('Eating protein earlier in the evening shifted sleep timing.')).toBe(true);
    });
  });
});
