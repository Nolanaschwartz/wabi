// First-chunk splitter for streaming first-sentence synthesis (see
// .scratch/streaming-first-sentence-tts/PRD.md). Given the accumulated reply, return the first
// synthesizable chunk + the remainder, or null to fall back to synthesizing the whole reply.

// A first chunk must hold at least this many chars before we'll split: enough audio (~1s) to cover the
// remainder's TTS first-frame latency so the seam doesn't gap. The onset-vs-gap knob — raise toward
// whole-reply if a gap is audible. ponytail: char-count heuristic, not prosody.
export const MIN_FIRST_CHARS = 60;

// Sentence ender (one or more of . ! ?) followed by whitespace or end-of-text. ponytail: no abbreviation
// handling ("Mr.", "1.5") — an early split there is harmless for TTS.
const ENDER = /[.!?]+(?=\s|$)/g;

export function splitFirstChunk(
  text: string,
  minChars: number = MIN_FIRST_CHARS,
): { chunk1: string; rest: string } | null {
  ENDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENDER.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end < minChars) continue; // sub-floor boundary — merge forward
    const rest = text.slice(end).trimStart();
    if (rest.length === 0) return null; // boundary at the very end — no remainder to overlap; whole-reply
    return { chunk1: text.slice(0, end), rest };
  }
  return null; // no qualifying boundary yet / at all — caller synthesizes the whole reply
}
