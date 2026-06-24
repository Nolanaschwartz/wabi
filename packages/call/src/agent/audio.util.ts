// PCM16 WAV pack/parse + naive resampling. Good enough for speech; not hi-fi.

export function buildWav(
  pcm: Int16Array,
  rate: number,
  channels: number,
): Buffer {
  const bytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  // ponytail: bulk byte copy; assumes host is little-endian (all our targets are).
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

export function parseWav(buf: Buffer): {
  data: Int16Array;
  rate: number;
  channels: number;
} {
  let off = 12; // skip RIFF + WAVE
  let rate = 24000;
  let channels = 1;
  let bits = 16;
  let dataOff = 44;
  let dataLen = buf.length - 44;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (bits !== 16)
    throw new Error(`TTS returned ${bits}-bit WAV; expected 16-bit PCM`);
  // A non-speakable chunk (lone emoji/punctuation) makes the TTS return a 0-byte WAV, so dataLen goes
  // negative. Bail out with empty audio before the copy below — an unclamped count threw "Invalid typed
  // array length", and a count of 0 with dataOff past the end would throw in buf.copy.
  const count = Math.max(0, Math.floor(dataLen / 2));
  if (count === 0) return { data: new Int16Array(0), rate, channels };
  const data = new Int16Array(count);
  // ponytail: copy the data bytes straight into the fresh (aligned) Int16Array backing store;
  // host is little-endian, so the int16 interpretation matches the WAV bytes 1:1. Copying into
  // `data` (rather than viewing `buf`) dodges Buffer-pool byteOffset misalignment.
  buf.copy(
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    0,
    dataOff,
    dataOff + count * 2,
  );
  return { data, rate, channels };
}

function toMono(pcm: Int16Array, channels: number): Int16Array {
  if (channels === 1) return pcm;
  const out = new Int16Array(Math.floor(pcm.length / channels));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += pcm[i * channels + c];
    out[i] = s / channels;
  }
  return out;
}

// ponytail: linear interpolation. Fine for voice; swap for a polyphase filter if quality matters.
export function resampleToMono(
  pcm: Int16Array,
  fromRate: number,
  fromCh: number,
  toRate: number,
): Int16Array {
  const mono = toMono(pcm, fromCh);
  if (fromRate === toRate) return mono;
  const ratio = toRate / fromRate;
  const out = new Int16Array(Math.floor(mono.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, mono.length - 1);
    out[i] = mono[i0] * (1 - (src - i0)) + mono[i1] * (src - i0);
  }
  return out;
}

// Duplicate a mono PCM stream into interleaved stereo (L=R). Discord wants 48kHz stereo and the TTS is
// mono, so pair this with resampleToMono(...,24000,1,48000) on the agent->Discord hop.
export function monoToStereo(mono: Int16Array): Int16Array {
  const out = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[2 * i] = mono[i];
    out[2 * i + 1] = mono[i];
  }
  return out;
}

// Linear fade-in applied IN PLACE across the first `fadeLen` samples of a stream. `done` = samples
// already faded across prior frames; returns the updated count. No-op once done >= fadeLen. Used to mask
// the click where two separately-synthesized clips are concatenated (the chunk1->remainder seam).
export function fadeIn(pcm: Int16Array, done: number, fadeLen: number): number {
  for (let i = 0; i < pcm.length && done < fadeLen; i++, done++) {
    pcm[i] = Math.round((pcm[i] * done) / fadeLen); // gain ramps 0 -> ~1 over fadeLen samples
  }
  return done;
}

export function rms(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Sum equal-length PCM frames into one, clamped to int16 (so overlapping speakers don't
// wrap on overflow). Returns null if there's nothing to mix. Single frame is passed through.
export function mixFrames(
  frames: Int16Array[],
  len: number,
): Int16Array | null {
  if (frames.length === 0) return null;
  if (frames.length === 1) return frames[0];
  const acc = new Int32Array(len);
  for (const f of frames) for (let i = 0; i < len; i++) acc[i] += f[i];
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = acc[i] > 32767 ? 32767 : acc[i] < -32768 ? -32768 : acc[i];
  }
  return out;
}
