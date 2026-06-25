import {
  buildWav,
  resampleToMono,
  concatInt16,
  mixFrames,
} from './audio.util';

describe('audio.util', () => {
  it('packs PCM into a WAV container with the right header', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32000, -32000]);
    const wav = buildWav(pcm, 24000, 1);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2); // data chunk size
    // payload bytes match the source PCM (host is little-endian); sample N at byte 44 + N*2
    expect(wav.readInt16LE(44)).toBe(0); // sample 0
    expect(wav.readInt16LE(46)).toBe(1000); // sample 1
    expect(wav.readInt16LE(50)).toBe(32000); // sample 3
    expect(wav.readInt16LE(52)).toBe(-32000); // sample 4
  });

  it('resamples to the target rate and downmixes to mono', () => {
    // 4 stereo frames @ 48k -> mono @ 24k should halve the sample count.
    const stereo = Int16Array.from([10, 10, 20, 20, 30, 30, 40, 40]);
    const out = resampleToMono(stereo, 48000, 2, 24000);
    expect(out.length).toBe(2); // 4 mono samples * (24000/48000)
  });

  it('concats chunks in order', () => {
    const out = concatInt16([Int16Array.from([1, 2]), Int16Array.from([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  describe('mixFrames', () => {
    it('sums overlapping speakers', () => {
      const out = mixFrames(
        [Int16Array.from([100, -50]), Int16Array.from([25, -50])],
        2,
      );
      expect(Array.from(out!)).toEqual([125, -100]);
    });

    it('clamps on overflow instead of wrapping', () => {
      const loud = Int16Array.from([30000, -30000]);
      const out = mixFrames([loud, loud], 2);
      expect(Array.from(out!)).toEqual([32767, -32768]);
    });

    it('returns null when no one is speaking, passes a single speaker through', () => {
      expect(mixFrames([], 2)).toBeNull();
      const solo = Int16Array.from([7, 8]);
      expect(mixFrames([solo], 2)).toBe(solo);
    });
  });
});
