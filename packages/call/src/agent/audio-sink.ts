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

  constructor(
    private readonly source: PcmSink,
    private readonly rate: number,
    private readonly channels: number,
  ) {
    this.frameLen = Math.round((rate * FRAME_MS) / 1000) * channels;
  }

  // Write PCM, chunked to 20ms frames. `shouldStop` is polled per frame so a barge-in
  // can cut playback mid-utterance.
  async write(pcm: Int16Array, shouldStop?: () => boolean): Promise<void> {
    for (let i = 0; i < pcm.length; i += this.frameLen) {
      if (shouldStop?.()) return;
      const frame = new Int16Array(
        pcm.subarray(i, Math.min(i + this.frameLen, pcm.length)),
      );
      try {
        await this.source.captureFrame(
          new AudioFrame(
            frame,
            this.rate,
            this.channels,
            frame.length / this.channels,
          ),
        );
      } catch {
        return; // source torn down mid-write (hangup)
      }
    }
  }

  clear(): void {
    try {
      this.source.clearQueue();
    } catch {
      /* already closed */
    }
  }
}
