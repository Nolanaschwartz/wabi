// The speech pipeline seam. Three interfaces keep the turn loop ignorant of any
// provider's wire format. Prod adapters live in openai-speech.ts; tests pass fakes.

export interface ChatMessage {
  role: string;
  content: string;
}

export interface Transcriber {
  transcribe(wav: Buffer): Promise<string>;
}

export interface Responder {
  // Streams the reply as text deltas; the turn loop accumulates them into the full reply (and times
  // TTFT / can abort early on barge). `signal` aborts the upstream call on barge-in/hangup.
  respondStream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}

export interface Synthesizer {
  // Streams 16-bit mono PCM (at SYNTH_RATE) as it's synthesized — first frame in ~0.6s — so playback
  // starts before the whole utterance renders. `signal` aborts on barge-in/hangup.
  synthesizeStream(text: string, signal?: AbortSignal): AsyncIterable<Int16Array>;

  // Approach B (streaming-text): feed reply text in incrementally as the LLM produces it and read ONE
  // continuous PCM stream back over a single session — no per-request seam. `text` completing ends the
  // utterance; `signal` aborts/closes the session. Optional: providers without a streaming session omit it.
  synthesizeSession?(
    text: AsyncIterable<string>,
    signal?: AbortSignal,
  ): AsyncIterable<Int16Array>;
}

export interface SpeechPipeline {
  transcriber: Transcriber;
  responder: Responder;
  synthesizer: Synthesizer;
}
