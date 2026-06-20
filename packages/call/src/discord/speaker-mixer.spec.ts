import { SpeakerMixer } from './speaker-mixer';

describe('SpeakerMixer', () => {
  it('sums one frame per active speaker on each tick', () => {
    const m = new SpeakerMixer(2);
    m.feed('a', Int16Array.from([100, 200]));
    m.feed('b', Int16Array.from([10, 20]));
    expect(Array.from(m.tick()!)).toEqual([110, 220]);
    expect(m.tick()).toBeNull(); // queues drained
  });

  it('returns null when no one is active', () => {
    expect(new SpeakerMixer(2).tick()).toBeNull();
  });

  it('passes a lone speaker through unmixed', () => {
    const m = new SpeakerMixer(2);
    const f = Int16Array.from([7, 8]);
    m.feed('solo', f);
    expect(m.tick()).toBe(f);
  });

  it('bounds latency by dropping oldest beyond maxQueue', () => {
    const m = new SpeakerMixer(2, 2); // keep at most 2 frames
    m.feed('a', Int16Array.from([1, 1]));
    m.feed('a', Int16Array.from([2, 2]));
    m.feed('a', Int16Array.from([3, 3])); // drops [1,1]
    expect(Array.from(m.tick()!)).toEqual([2, 2]); // oldest survivor, not [1,1]
  });

  it('drop() removes a speaker', () => {
    const m = new SpeakerMixer(2);
    m.feed('a', Int16Array.from([5, 5]));
    m.drop('a');
    expect(m.tick()).toBeNull(); // dropped speaker contributes no audio
  });
});
