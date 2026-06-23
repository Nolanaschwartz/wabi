import {
  buildWav,
  parseWav,
  resampleToMono,
  concatInt16,
  mixFrames,
} from './audio.util';

describe('audio.util', () => {
  it('round-trips PCM through a WAV container', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32000, -32000]);
    const { data, rate, channels } = parseWav(buildWav(pcm, 24000, 1));
    expect(rate).toBe(24000);
    expect(channels).toBe(1);
    expect(Array.from(data)).toEqual(Array.from(pcm));
  });

  it('returns empty data for an empty/short buffer instead of throwing', () => {
    // A non-speakable TTS chunk (e.g. a lone emoji) yields a 0-byte WAV. parseWav must
    // not compute a negative Int16Array length ("Invalid typed array length: -22").
    expect(() => parseWav(Buffer.alloc(0))).not.toThrow();
    expect(parseWav(Buffer.alloc(0)).data.length).toBe(0);
    expect(parseWav(Buffer.alloc(10)).data.length).toBe(0); // shorter than a 44-byte header
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
