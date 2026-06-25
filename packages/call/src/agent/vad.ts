// Energy VAD front-end for the turn detector. Self-contained on purpose: all the
// robustness logic lives here (high-passed RMS, not a bare RMS) so a noisy gaming
// room doesn't false-barge and a quiet talker isn't clipped.
//
// Two pieces, both cheap enough to run per 20ms frame:
//   1. DC / high-pass pre-filter — a one-pole DC blocker strips low-frequency
//      rumble and constant offsets (fans, mains hum, a stuck DC bias) before we
//      measure energy, so sub-audible junk can't inflate RMS into a false turn.
//      The filter is primed on the first sample so a steady offset doesn't ring as
//      a one-frame onset transient.
//   2. Adaptive noise floor — an EMA of the background level. The speech
//      threshold is derived from it (floor * margin), with a small absolute guard
//      so true silence/hiss never reads as speech, and detection tracks gain/room
//      instead of a single hard-coded constant. A quiet talker above the tracked
//      background registers even when below the legacy raw cutoff.
//
// A frame counts as speech when its high-passed RMS clears the adaptive threshold
// AND it isn't dominated by hard clipping (saturated SFX reads as high energy but
// is mostly full-scale samples, so we discount it).

export interface VadTuning {
  // Absolute floor on the threshold: high-passed RMS must beat this regardless of
  // how quiet the background is, so digital silence / faint hiss never trips. Kept
  // well below typical speech energy so genuinely quiet talkers still pass.
  silenceGuard: number;
  // Speech must exceed floor * marginAbove. >1 so the background itself doesn't
  // qualify; the margin is the speech-over-noise headroom.
  marginAbove: number;
  // EMA step sizes (per frame). Floor rises slowly toward louder energy (a brief
  // loud talker doesn't drag it up and deafen us) and falls fast toward quiet (we
  // recover sensitivity for the next quiet talker the moment it goes silent).
  floorRiseAlpha: number;
  floorFallAlpha: number;
  // High-pass coefficient (one-pole DC blocker). Closer to 1 = lower cutoff. At
  // 48kHz, 0.995 ≈ ~38Hz cutoff: kills DC/rumble, keeps the speech band intact.
  hpCoeff: number;
  // |sample| at/over this counts toward clip detection; a frame with at least
  // clipRatio of such samples is treated as saturated noise, not voiced speech.
  clipLevel: number;
  clipRatio: number;
}

export const DEFAULT_VAD_TUNING: VadTuning = {
  silenceGuard: 150,
  marginAbove: 1.6,
  floorRiseAlpha: 0.02,
  floorFallAlpha: 0.25,
  hpCoeff: 0.995,
  clipLevel: 32000,
  clipRatio: 0.5,
};

export class EnergyVad {
  private readonly t: VadTuning;
  // High-pass filter state. Carries across frames so a sustained tone stays steady.
  private prevX = 0;
  private prevY = 0;
  private primed = false;
  // Tracked background level (EMA of high-passed RMS over non-speech frames). Seeded
  // to the silence guard so the first real (possibly quiet) frame can still pass.
  private floor: number;

  constructor(tuning: Partial<VadTuning> = {}) {
    this.t = { ...DEFAULT_VAD_TUNING, ...tuning };
    this.floor = this.t.silenceGuard;
  }

  // One-pole high-pass: y[n] = a*(y[n-1] + x[n] - x[n-1]). Returns RMS of the
  // filtered frame. Primes prevX on the very first sample so a steady DC offset
  // produces ~0 energy instead of a startup edge transient.
  private highPassedRms(frame: Int16Array): number {
    const a = this.t.hpCoeff;
    if (!this.primed) {
      this.prevX = frame[0];
      this.prevY = 0;
      this.primed = true;
    }
    let sum = 0;
    let px = this.prevX;
    let py = this.prevY;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i];
      const y = a * (py + x - px);
      px = x;
      py = y;
      sum += y * y;
    }
    this.prevX = px;
    this.prevY = py;
    return Math.sqrt(sum / frame.length);
  }

  private clipFraction(frame: Int16Array): number {
    const lvl = this.t.clipLevel;
    let n = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      if (v >= lvl || v <= -lvl) n++;
    }
    return n / frame.length;
  }

  // A constant (DC) frame has no AC content and can't be voiced speech. This also
  // rejects the high-pass's boundary transient when a steady level steps to another
  // steady level (e.g. a clipped SFX dropping back to silence): the post-step frame
  // is itself constant, so we don't report its decaying filter ring as an onset.
  private isConstant(frame: Int16Array): boolean {
    const first = frame[0];
    for (let i = 1; i < frame.length; i++) if (frame[i] !== first) return false;
    return true;
  }

  // True when the frame is speech. Updates the adaptive noise floor as a side
  // effect: it falls fast toward quiet and rises slowly toward louder energy
  // (whether or not the frame read as speech), so a sustained loud bed is absorbed
  // while a normal talker's turns finish before the floor catches up.
  isSpeech(frame: Int16Array): boolean {
    if (frame.length === 0) return false;
    const energy = this.highPassedRms(frame);

    const threshold = Math.max(this.t.silenceGuard, this.floor * this.t.marginAbove);

    // Heavily-clipped frames (saturated SFX/pops) carry high energy but are mostly
    // full-scale: don't let pure saturation count as a voiced turn. They still feed
    // the noise floor (as background), so sustained clipping raises the bar instead
    // of barging on every frame.
    const clipped = this.clipFraction(frame) >= this.t.clipRatio;
    const speech = !clipped && !this.isConstant(frame) && energy > threshold;

    // Track the background. Non-speech frames pull the floor toward the current
    // energy (fast down to recover sensitivity, slow up). Speech frames also nudge
    // the floor up, but very slowly, so a *sustained* steady bed (music/fan that
    // first reads as speech) is eventually absorbed and stops false-barging, while a
    // genuine talker's normal turns finish long before the floor catches them.
    const alpha =
      energy > this.floor ? this.t.floorRiseAlpha : this.t.floorFallAlpha;
    this.floor = this.floor + alpha * (energy - this.floor);
    if (this.floor < this.t.silenceGuard) this.floor = this.t.silenceGuard;
    return speech;
  }
}
