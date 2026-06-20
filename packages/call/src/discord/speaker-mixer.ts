import { mixFrames } from '../agent/audio.util';

// Mixes per-speaker PCM into one stream so simultaneous Discord talkers don't collide.
// feed() decoded frames per speaker into bounded jitter queues; tick() pulls one frame
// from each active speaker and returns the clamped sum (or null when everyone is idle).
// Pure state + arithmetic — no Discord/LiveKit I/O, so the interface is the test surface.
export class SpeakerMixer {
  private readonly queues = new Map<string, Int16Array[]>();

  constructor(
    private readonly frameLen: number, // interleaved int16s per 20ms frame
    private readonly maxQueue = 5, // per-speaker jitter cap (~100ms) to bound latency
  ) {}

  feed(userId: string, frame: Int16Array): void {
    let q = this.queues.get(userId);
    if (!q) {
      q = [];
      this.queues.set(userId, q);
    }
    q.push(frame);
    if (q.length > this.maxQueue) q.shift(); // drop oldest, keep latency bounded
  }

  drop(userId: string): void {
    this.queues.delete(userId);
  }

  has(userId: string): boolean {
    return this.queues.has(userId);
  }

  // One mixed frame; null if no speaker had audio this tick.
  tick(): Int16Array | null {
    if (this.queues.size === 0) return null;
    const frames: Int16Array[] = [];
    for (const q of this.queues.values()) {
      const f = q.shift();
      if (f) frames.push(f);
    }
    return mixFrames(frames, this.frameLen);
  }
}
