import { rms, concatInt16 } from './audio.util';

export interface Utterance {
  pcm: Int16Array;
  rate: number;
  channels: number;
}

export interface TurnDetectorOpts {
  vadRms: number; // RMS above this counts as speech
  hangoverMs: number; // trailing silence that ends a turn
  minTurnMs: number; // ignore turns shorter than this
  bargeMs: number; // sustained speech (while suppressed) that triggers barge-in
  prerollMs: number; // audio kept before speech, to capture word onsets
}

export type TurnEvent = { utterance: Utterance } | { barge: true };

// Frame-driven turn detection: push frames in, get turns out. Owns VAD, pre-roll,
// hangover, min-turn, and barge-in — the logic where every onset/cutoff bug lived.
// No I/O: the interface (push + setSuppressed) is the test surface.
export class TurnDetector {
  private speaking = false;
  private silenceMs = 0;
  private bargeMs = 0;
  private buf: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  private prerollMs = 0;
  private suppressed = false; // assistant is talking: watch for barge-in, don't capture turns

  constructor(private readonly o: TurnDetectorOpts) {}

  // Caller flips this when the assistant starts/stops speaking.
  setSuppressed(v: boolean): void {
    this.suppressed = v;
    if (v) {
      this.speaking = false;
      this.silenceMs = 0;
      this.buf = [];
    } else {
      this.bargeMs = 0;
    }
  }

  // Returns a completed Utterance, a barge-in signal, or null. Copies frames it keeps
  // (the caller may reuse the underlying buffer after we return).
  push(frame: Int16Array, rate: number, channels: number): TurnEvent | null {
    const frameMs = (frame.length / channels / rate) * 1000;
    const isSpeech = rms(frame) > this.o.vadRms;

    if (this.suppressed) {
      this.addPreroll(frame, frameMs, rate, channels);
      this.bargeMs = isSpeech ? this.bargeMs + frameMs : 0;
      if (this.bargeMs >= this.o.bargeMs) {
        this.bargeMs = 0;
        return { barge: true };
      }
      return null;
    }

    if (isSpeech) {
      if (!this.speaking) {
        this.speaking = true;
        this.buf = this.preroll; // seed the turn with the captured onset
        this.preroll = [];
        this.prerollMs = 0;
      }
      this.silenceMs = 0;
      this.buf.push(frame.slice());
      return null;
    }

    if (this.speaking) {
      this.silenceMs += frameMs;
      this.buf.push(frame.slice());
      if (this.silenceMs >= this.o.hangoverMs) {
        const pcm = concatInt16(this.buf);
        this.buf = [];
        this.speaking = false;
        this.silenceMs = 0;
        if ((pcm.length / channels / rate) * 1000 >= this.o.minTurnMs) {
          return { utterance: { pcm, rate, channels } };
        }
      }
      return null;
    }

    this.addPreroll(frame, frameMs, rate, channels);
    return null;
  }

  private addPreroll(
    frame: Int16Array,
    ms: number,
    rate: number,
    channels: number,
  ): void {
    this.preroll.push(frame.slice());
    this.prerollMs += ms;
    while (this.prerollMs > this.o.prerollMs && this.preroll.length > 1) {
      this.prerollMs -= (this.preroll.shift()!.length / channels / rate) * 1000;
    }
  }
}
