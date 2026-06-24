import { VoicePlayout } from './voice-playout';

// settle: let a resolved/queued microtask-or-macrotask promise win (mirrors playout-drain.spec).
const settled = (p: Promise<void>) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 0)),
  ]);

// Discord output port stand-in: a buffer queue exposing the same surface the pacer touches on the real
// pcmOut Readable — readableLength (bytes pending) + push(b). pump() drains here; we inspect frames.
class FakePort {
  pushed: Buffer[] = [];
  // The real Readable drops bytes out as the player consumes them; default is "nothing consumed yet"
  // so a single pump() fills to the cushion and we can assert on it. consume() simulates playback.
  readableLength = 0;
  push(b: Buffer): void {
    this.pushed.push(Buffer.from(b));
    this.readableLength += b.length;
  }
  consume(bytes: number): void {
    this.readableLength = Math.max(0, this.readableLength - bytes);
  }
}

// Frame geometry — must match the module's constants (48kHz stereo s16le, 20ms frame).
const FRAME_BYTES = 960 * 2 * 2; // FRAME_SAMPLES * CHANNELS * 2
const CUSHION = FRAME_BYTES * 3;
const FLOOR = FRAME_BYTES * 2;
const MAX_OUT = FRAME_BYTES * 50 * 30;

// 24kHz mono → after resample×2 + stereo×2 → 4× the samples in bytes. n mono samples @24k => one
// 48k stereo frame is 960 stereo samples; feeding 480 mono @24k yields exactly one 48k frame.
const monoSamplesForFrames = (frames: number) => 480 * frames;
// Non-zero audio so real frames are byte-distinguishable from the silence floor.
const tone = (n: number) => Int16Array.from({ length: n }, (_, i) => 1000 + (i % 100));
const writeFrames = (p: VoicePlayout, frames: number) =>
  p.write(tone(monoSamplesForFrames(frames)));

describe('VoicePlayout', () => {
  it('fills the port up to CUSHION with real frames on a pump tick', () => {
    const p = new VoicePlayout();
    writeFrames(p, 10); // plenty of real audio queued
    const port = new FakePort();
    p.pump(port);
    // Pacer keeps a CUSHION (3 frames) of real audio; floor never fires while real audio leads.
    expect(port.readableLength).toBe(CUSHION);
    expect(port.pushed.length).toBe(3);
    expect(port.pushed.every((b) => b.length === FRAME_BYTES)).toBe(true);
  });

  it('injects FLOOR silence on underrun when no real audio is queued', () => {
    const p = new VoicePlayout();
    const port = new FakePort(); // nothing written
    p.pump(port);
    // No real frames available → only the silence floor is pushed (2 frames of zeros).
    expect(port.readableLength).toBe(FLOOR);
    expect(port.pushed.length).toBe(2);
    expect(port.pushed.every((b) => b.equals(Buffer.alloc(FRAME_BYTES)))).toBe(true);
  });

  it('tops up the floor with silence after a partial real fill', () => {
    const p = new VoicePlayout();
    writeFrames(p, 1); // exactly one real frame available
    const port = new FakePort();
    p.pump(port);
    // 1 real frame + silence up to FLOOR (so total >= FLOOR, real frame counts toward it).
    expect(port.pushed.length).toBe(2); // 1 real + 1 silence to reach FLOOR (2 frames)
    expect(port.readableLength).toBe(FLOOR);
    expect(port.pushed[0].equals(Buffer.alloc(FRAME_BYTES))).toBe(false); // first frame is real (non-zero)
    expect(port.pushed[1].equals(Buffer.alloc(FRAME_BYTES))).toBe(true); // second is silence
  });

  it('retains a sub-frame remainder in the buffer for a later chunk', () => {
    const p = new VoicePlayout();
    // 1.5 frames worth of mono → resamples to 1.5 stereo frames; pacer emits whole frames only.
    p.write(tone(Math.floor(monoSamplesForFrames(1) * 1.5)));
    const port = new FakePort();
    p.pump(port);
    // One whole frame emitted; the half-frame remainder stays buffered (not flushed as a short frame).
    const realFrames = port.pushed.filter((b) => b.length === FRAME_BYTES);
    expect(realFrames.length).toBeGreaterThanOrEqual(1);
    // Drain still reports pending? No — only a sub-frame remainder < FRAME_BYTES remains, and the floor
    // is satisfied, so pendingReal is false. But the remainder must not have been lost: feed more and it
    // completes a frame.
    const before = p.pendingBytes();
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(FRAME_BYTES);
  });

  it('caps queued audio at MAX_OUT as a runaway backstop, keeping the newest bytes', () => {
    const p = new VoicePlayout();
    // Write well past MAX_OUT in one go (mono samples → ×4 bytes after resample+stereo).
    const monoSamples = Math.floor(MAX_OUT / 4) + 100000;
    p.write(new Int16Array(monoSamples));
    expect(p.pendingBytes()).toBe(MAX_OUT); // clamped to the cap, oldest dropped
  });

  it('clear() drops queued audio and resolves the drain gate (barge)', async () => {
    const p = new VoicePlayout();
    writeFrames(p, 5);
    const gate = p.whenDrained();
    // Drive a tick so the gate would otherwise stay suppressed (real audio pending).
    p.pump(new FakePort());
    expect(await settled(gate)).toBe(false);

    p.clear();
    expect(p.pendingBytes()).toBe(0);
    expect(await settled(gate)).toBe(true); // barge released the gate
  });

  it('whenDrained resolves only after the tail has actually played out', async () => {
    const p = new VoicePlayout();
    writeFrames(p, 6); // 6 real frames
    const gate = p.whenDrained();
    const port = new FakePort();

    // Tick 1: cushion fills 3 real frames; 3 real frames still buffered → pending (outBuf has frames).
    p.pump(port);
    expect(await settled(gate)).toBe(false);

    // Player consumes everything; tick 2 pushes the remaining 3 real frames into the cushion (outBuf
    // empty after) but 3 real frames now lead above the FLOOR → still pending (readableLength > FLOOR).
    port.consume(port.readableLength);
    p.pump(port);
    expect(await settled(gate)).toBe(false);

    // Player consumes the real lead; tick 3 has no real audio left and only refills the silence floor →
    // pendingReal false → drain releases.
    port.consume(port.readableLength);
    p.pump(port);
    expect(await settled(gate)).toBe(true);
  });

  it('close() resolves any pending and future drain gates (teardown fail-open)', async () => {
    const p = new VoicePlayout();
    writeFrames(p, 3);
    const pending = p.whenDrained();
    p.pump(new FakePort());
    expect(await settled(pending)).toBe(false);

    p.close();
    expect(await settled(pending)).toBe(true);
    expect(await settled(p.whenDrained())).toBe(true);
  });
});
