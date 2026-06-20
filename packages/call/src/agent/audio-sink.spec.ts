import { AudioSink } from './audio-sink';

class FakeSource {
  frames: {
    len: number;
    offset: number;
    samplesPerChannel: number;
    first: number;
  }[] = [];
  cleared = 0;
  fail = false;
  async captureFrame(f: any) {
    if (this.fail) throw new Error('InvalidState');
    // record byteOffset to prove we got an offset-0 buffer, not a shared view
    this.frames.push({
      len: f.data.length,
      offset: f.data.byteOffset,
      samplesPerChannel: f.samplesPerChannel,
      first: f.data[0],
    });
  }
  clearQueue() {
    this.cleared++;
  }
}

describe('AudioSink', () => {
  it('chunks PCM into 20ms frames, each an offset-0 buffer', async () => {
    const src = new FakeSource();
    const sink = new AudioSink(src as any, 48000, 1); // 20ms @ 48k mono = 960 samples
    await sink.write(new Int16Array(960 * 3)); // 60ms -> 3 frames
    expect(src.frames.length).toBe(3);
    expect(src.frames.every((f) => f.len === 960)).toBe(true);
    expect(src.frames.every((f) => f.offset === 0)).toBe(true); // the protoInfo footgun
    expect(src.frames.every((f) => f.samplesPerChannel === 960)).toBe(true);
  });

  it('preserves chunk content (not just frame 0 repeated)', async () => {
    const src = new FakeSource();
    const sink = new AudioSink(src as any, 48000, 1);
    const pcm = new Int16Array(960 * 2);
    pcm[0] = 11; // frame 0 marker
    pcm[960] = 22; // frame 1 marker
    await sink.write(pcm);
    expect(src.frames[0].first).toBe(11);
    expect(src.frames[1].first).toBe(22); // would be 11 if we sent a shared view
  });

  it('stops mid-write when shouldStop flips (barge-in)', async () => {
    const src = new FakeSource();
    const sink = new AudioSink(src as any, 48000, 1);
    let stop = false;
    const p = sink.write(new Int16Array(960 * 5), () => stop);
    stop = true; // before the first synchronous frame? set after — emulate via immediate stop
    await p;
    expect(src.frames.length).toBeLessThan(5);
  });

  it('swallows captureFrame errors from a torn-down source', async () => {
    const src = new FakeSource();
    src.fail = true;
    const sink = new AudioSink(src as any, 48000, 1);
    await expect(sink.write(new Int16Array(960))).resolves.toBeUndefined();
  });

  it('handles stereo samplesPerChannel', async () => {
    const src = new FakeSource();
    const sink = new AudioSink(src as any, 48000, 2); // 960*2 interleaved per 20ms
    await sink.write(new Int16Array(960 * 2));
    expect(src.frames[0].len).toBe(1920);
    expect(src.frames[0].samplesPerChannel).toBe(960);
  });
});
