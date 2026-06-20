import { TurnDetector, TurnEvent } from './turn-detector';

const RATE = 48000;
const CH = 1;
const FRAME = 480; // 10ms @ 48k mono

const loud = () => new Int16Array(FRAME).fill(5000); // rms 5000 > threshold
const quiet = () => new Int16Array(FRAME); // zeros

const opts = {
  vadRms: 600,
  hangoverMs: 100,
  minTurnMs: 50,
  bargeMs: 50,
  prerollMs: 50,
};

function feed(
  d: TurnDetector,
  frame: () => Int16Array,
  n: number,
): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (let i = 0; i < n; i++) {
    const e = d.push(frame(), RATE, CH);
    if (e) out.push(e);
  }
  return out;
}

describe('TurnDetector', () => {
  it('emits an utterance after hangover silence', () => {
    const d = new TurnDetector(opts);
    expect(feed(d, loud, 10)).toHaveLength(0); // 100ms speech, no end yet
    const events = feed(d, quiet, 10); // 100ms silence -> hangover
    expect(events).toHaveLength(1);
    expect('utterance' in events[0]).toBe(true);
  });

  it('includes pre-roll so the onset is not clipped', () => {
    const d = new TurnDetector(opts);
    feed(d, quiet, 8); // fills pre-roll (capped at 50ms = 5 frames)
    feed(d, loud, 10);
    const [e] = feed(d, quiet, 10);
    const utt = (e as { utterance: any }).utterance;
    // 10 speech + (hangover) silence + up to 5 pre-roll frames, each 480 samples
    expect(utt.pcm.length).toBeGreaterThan(10 * FRAME); // pre-roll added ahead of speech
  });

  it('drops sub-min-turn blips', () => {
    const d = new TurnDetector({ ...opts, minTurnMs: 1000 });
    feed(d, loud, 2); // 20ms speech only
    expect(feed(d, quiet, 10)).toHaveLength(0); // too short -> no utterance
  });

  it('signals barge-in on sustained speech while suppressed', () => {
    const d = new TurnDetector(opts);
    d.setSuppressed(true);
    const events = feed(d, loud, 6); // 60ms >= bargeMs 50
    expect(events.some((e) => 'barge' in e)).toBe(true);
  });

  it('does not capture turns while suppressed', () => {
    const d = new TurnDetector(opts);
    d.setSuppressed(true);
    feed(d, loud, 6);
    d.setSuppressed(false);
    // no utterance should have leaked out during suppression
    const events = feed(d, quiet, 10);
    expect(events).toHaveLength(0);
  });
});
