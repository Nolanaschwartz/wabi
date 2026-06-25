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
