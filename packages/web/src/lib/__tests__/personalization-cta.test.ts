import { personalizationCta } from '../personalization-cta';

describe('personalizationCta', () => {
  it('prompts to finish setup when onboarding is incomplete', () => {
    expect(personalizationCta(false)).toEqual({
      kind: 'finish',
      href: '/onboarding',
      label: 'Finish personalizing Wabi',
    });
  });

  it('offers an edit link when onboarding is complete', () => {
    expect(personalizationCta(true)).toEqual({
      kind: 'edit',
      href: '/onboarding',
      label: 'Edit your personalization',
    });
  });
});
