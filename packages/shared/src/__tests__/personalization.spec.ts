import {
  IMPROVEMENT_AREAS,
  INTERESTS,
  expandAreas,
  interestLabels,
} from '../personalization';

describe('expandAreas', () => {
  it('maps each known area slug to its query phrase', () => {
    expect(expandAreas(['tilt'])).toEqual([
      'managing tilt and frustration while gaming',
    ]);
    expect(expandAreas(['focus', 'sleep'])).toEqual([
      'improving focus and concentration',
      'better sleep and rest',
    ]);
  });

  it('drops unknown slugs', () => {
    expect(expandAreas(['tilt', 'not-a-real-area'])).toEqual([
      'managing tilt and frustration while gaming',
    ]);
  });

  it('returns an empty array for no slugs', () => {
    expect(expandAreas([])).toEqual([]);
  });

  it('drops inherited Object.prototype keys (no prototype pollution)', () => {
    expect(expandAreas(['constructor', '__proto__', 'toString', 'hasOwnProperty'])).toEqual([]);
    expect(expandAreas(['constructor', 'tilt'])).toEqual([
      'managing tilt and frustration while gaming',
    ]);
  });
});

describe('interestLabels', () => {
  it('maps each known interest slug to its label', () => {
    expect(interestLabels(['fps', 'music'])).toEqual(['FPS', 'Music']);
  });

  it('drops unknown slugs', () => {
    expect(interestLabels(['fps', 'nope'])).toEqual(['FPS']);
  });

  it('returns an empty array for no slugs', () => {
    expect(interestLabels([])).toEqual([]);
  });

  it('drops inherited Object.prototype keys (no prototype pollution)', () => {
    expect(interestLabels(['constructor', '__proto__', 'valueOf'])).toEqual([]);
    expect(interestLabels(['toString', 'fps'])).toEqual(['FPS']);
  });
});

describe('vocabularies', () => {
  it('exposes the nine canonical improvement areas', () => {
    expect(Object.keys(IMPROVEMENT_AREAS)).toEqual([
      'tilt',
      'focus',
      'sleep',
      'social-connection',
      'burnout',
      'motivation',
      'screen-time-balance',
      'confidence',
      'stress',
    ]);
  });

  it('exposes the ten canonical interests', () => {
    expect(Object.keys(INTERESTS)).toEqual([
      'fps',
      'moba',
      'rpg',
      'ranked-grind',
      'streaming',
      'speedrunning',
      'music',
      'fitness',
      'co-op-with-friends',
      'single-player-story',
    ]);
  });
});
