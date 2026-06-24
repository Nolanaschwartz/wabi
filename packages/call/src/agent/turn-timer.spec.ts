import { TurnTimer, type Clock } from './turn-timer';

/** A clock that returns each value in sequence on successive calls. */
const seqClock = (values: number[]): Clock => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe('TurnTimer', () => {
  it('renders the full summary with correct deltas when all marks are present', () => {
    // start=1000, stt=1480, llm=2100, sentence=2300, audio=2900, done=4100
    const timer = new TurnTimer(seqClock([1000, 1480, 2100, 2300, 2900, 4100]));
    timer.mark('stt');
    timer.mark('llm');
    timer.mark('sentence');
    timer.mark('audio');
    timer.mark('done');

    expect(timer.render()).toBe(
      'latency stt=480ms llm_ttft=1100ms sent1=200ms tts_first=600ms first_audio=1900ms total=3100ms',
    );
  });

  it('renders dependent fields as na when a required mark is missing', () => {
    // omit 'sentence' → sent1 and tts_first become na; others stay numeric
    const timer = new TurnTimer(seqClock([1000, 1480, 2100, 2900, 4100]));
    timer.mark('stt');
    timer.mark('llm');
    timer.mark('audio');
    timer.mark('done');

    expect(timer.render()).toBe(
      'latency stt=480ms llm_ttft=1100ms sent1=na tts_first=na first_audio=1900ms total=3100ms',
    );
  });

  it('uses the first timestamp when a mark is recorded twice (first-call-wins)', () => {
    // start=1000, first stt=1480, second stt=9999 (ignored)
    const timer = new TurnTimer(seqClock([1000, 1480, 9999]));
    timer.mark('stt');
    timer.mark('stt');

    expect(timer.render()).toBe(
      'latency stt=480ms llm_ttft=na sent1=na tts_first=na first_audio=na total=na',
    );
  });

  it('works with the default Date.now clock without throwing', () => {
    const timer = new TurnTimer();
    timer.mark('stt');
    timer.mark('llm');
    timer.mark('sentence');
    timer.mark('audio');
    timer.mark('done');

    const out = timer.render();
    expect(out).toMatch(/^latency /);
    expect(out).toMatch(/total=\d+ms$/);
  });
});
