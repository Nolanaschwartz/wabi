import { concatInt16 } from './audio.util';
import { EnergyVad } from './vad';

export interface Utterance {
  pcm: Int16Array;
  rate: number;
  channels: number;
}

export interface TurnDetectorOpts {
  vadRms: number; // hard floor for the adaptive speech threshold (high-passed RMS)
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
  // DC/high-pass + adaptive-noise-floor VAD (see vad.ts). vadRms is the hard floor
  // for the adaptive threshold, not a bare RMS cutoff — so quiet talkers above the
  // tracked background still register and low-freq rumble/clipping don't false-fire.
  private readonly vad: EnergyVad;

  constructor(private readonly o: TurnDetectorOpts) {
    // vadRms is no longer a raw cutoff; it scales the absolute silence guard. The
    // adaptive floor + speech margin do the real work, so a quiet talker above the
    // tracked background still registers even when below the legacy vadRms value.
    this.vad = new EnergyVad({ silenceGuard: o.vadRms * 0.25 });
  }

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
    const isSpeech = this.vad.isSpeech(frame);

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
