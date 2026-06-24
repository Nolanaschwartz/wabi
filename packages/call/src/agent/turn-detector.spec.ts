import { TurnDetector, TurnEvent } from './turn-detector';

const RATE = 48000;
const CH = 1;
const FRAME = 480; // 10ms @ 48k mono

// A real voiced frame is an AC signal, not a DC offset. We use a tone well inside
// the speech band so the DC/high-pass keeps it (a constant-fill frame is rumble, not
// speech, and is now used as the negative case below).
function tone(amp: number, hz = 300, phase = 0): () => Int16Array {
  return () => {
    const out = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE + phase));
    }
    return out;
  };
}

// Carry phase across frames so a sustained tone is continuous (avoids per-frame
// onset transients dominating the high-passed energy).
function continuousTone(amp: number, hz = 300): () => Int16Array {
  let n = 0;
  return () => {
    const out = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++, n++) {
      out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * n) / RATE));
    }
    return out;
  };
}

const loud = tone(8000); // clearly-voiced, well above any adaptive floor
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

  // ---- VAD robustness (slice 10) ----

  it('does NOT register low-frequency rumble as speech', () => {
    const d = new TurnDetector(opts);
    // A big DC offset / sub-audible rumble: huge raw RMS, but no speech-band energy.
    // The high-pass should strip it, so it must never start a turn.
    const rumble = () => new Int16Array(FRAME).fill(9000);
    expect(feed(d, rumble, 20)).toHaveLength(0);
    const events = feed(d, quiet, 20);
    expect(events).toHaveLength(0); // nothing was ever captured -> no utterance to flush
  });

  it('registers quiet-but-real speech that clears the adaptive floor', () => {
    const d = new TurnDetector(opts);
    // Amplitude below the legacy hard vadRms=600 raw threshold, but a genuine tone
    // with real speech-band energy and a quiet background -> adaptive floor lets it in.
    const quietSpeech = continuousTone(450);
    expect(feed(d, quietSpeech, 12)).toHaveLength(0); // accumulating speech
    const events = feed(d, quiet, 12); // hangover -> flush
    expect(events).toHaveLength(1);
    expect('utterance' in events[0]).toBe(true);
  });

  it('does not let a single clipped/loud-noise burst run away as a turn', () => {
    const d = new TurnDetector(opts);
    // A short saturated burst (game SFX / pop) near full-scale, then silence.
    // It should be treated sanely: either ignored, or capped to a sub-min-turn blip
    // that the min-turn gate drops — never an emitted utterance from one burst.
    const clip = () => new Int16Array(FRAME).fill(32767);
    feed(d, clip, 2); // 20ms of saturated noise
    const events = feed(d, quiet, 20);
    expect(events).toHaveLength(0);
  });

  it('adapts: a sustained steady background is absorbed and stops barging', () => {
    const d = new TurnDetector(opts);
    d.setSuppressed(true);
    // A sustained mid-level steady tone (fan / music bed) — initially loud enough to
    // look like a barge. The adaptive floor must catch up so it stops perpetually
    // firing barges. We assert the *steady-state*: once adapted, no more barges.
    const bed = continuousTone(700, 200);

    const warmup = feed(d, bed, 60); // ~600ms: floor climbs over the bed
    const steady = feed(d, bed, 140); // ~1.4s more of the same steady bed

    // It may barge a few times before the floor absorbs the bed, but the steady-state
    // tail must be silent — a fixed threshold would barge forever here.
    expect(steady.filter((e) => 'barge' in e)).toHaveLength(0);
    // And the warm-up run is bounded (not one barge per window).
    expect(warmup.filter((e) => 'barge' in e).length).toBeLessThan(8);
  });
});
