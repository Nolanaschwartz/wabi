import { AudioFrame } from '@livekit/rtc-node';

// Structural view of a LiveKit AudioSource — lets tests pass a fake.
export interface PcmSink {
  captureFrame(frame: AudioFrame): Promise<void>;
  clearQueue(): void;
}

const FRAME_MS = 20;

// Deep sink over a LiveKit AudioSource. Owns the rtc-node capture contract that was
// previously re-derived at every call site:
//   - each frame must own an offset-0 buffer (protoInfo() serializes the whole
//     ArrayBuffer, ignoring a subarray's byteOffset — a view sends frame 0 every time);
//   - audio is fed in ~20ms frames to pace playback;
//   - captureFrame rejects InvalidState once the source is torn down (hangup) — swallowed.
// Input PCM must already be at this sink's rate/channels.
export class AudioSink {
  private readonly frameLen: number; // interleaved int16s per 20ms frame
  private carry: Int16Array = new Int16Array(0); // sub-frame remainder held between writes

  constructor(
    private readonly source: PcmSink,
    private readonly rate: number,
    private readonly channels: number,
  ) {
    this.frameLen = Math.round((rate * FRAME_MS) / 1000) * channels;
  }

  // Write PCM as full 20ms frames; any sub-frame tail is held in `carry` and prepended to the next
  // write. This is what keeps a streamed reply (fed in many odd-sized chunks) from emitting scattered
  // partial frames mid-stream — those caused audible distortion. Call flush() to emit the final tail.
  // `shouldStop` is polled per frame so a barge-in can cut playback mid-utterance.
  async write(pcm: Int16Array, shouldStop?: () => boolean): Promise<void> {
    const buf = this.carry.length ? this.join(this.carry, pcm) : pcm;
    let i = 0;
    for (; i + this.frameLen <= buf.length; i += this.frameLen) {
      if (shouldStop?.()) {
        this.carry = new Int16Array(0);
        return;
      }
      const frame = new Int16Array(buf.subarray(i, i + this.frameLen));
      try {
        await this.source.captureFrame(
          new AudioFrame(frame, this.rate, this.channels, frame.length / this.channels),
        );
      } catch {
        this.carry = new Int16Array(0);
        return; // source torn down mid-write (hangup)
      }
    }
    this.carry = i < buf.length ? new Int16Array(buf.subarray(i)) : new Int16Array(0);
  }

  // Emit any buffered sub-frame remainder (one short final frame) — call at the end of an utterance.
  async flush(shouldStop?: () => boolean): Promise<void> {
    const rem = this.carry;
    this.carry = new Int16Array(0);
    if (rem.length === 0 || shouldStop?.()) return;
    try {
      await this.source.captureFrame(
        new AudioFrame(new Int16Array(rem), this.rate, this.channels, rem.length / this.channels),
      );
    } catch {
      /* source torn down */
    }
  }

  clear(): void {
    this.carry = new Int16Array(0);
    try {
      this.source.clearQueue();
    } catch {
      /* already closed */
    }
  }

  private join(a: Int16Array, b: Int16Array): Int16Array {
    const out = new Int16Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
}
