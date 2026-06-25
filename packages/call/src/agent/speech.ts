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
  // Streaming-text TTS over ONE continuous session: feed reply text in incrementally as the LLM produces
  // it and read one continuous 16-bit mono PCM stream (at 24kHz) back — no per-request seam, one synthesis
  // take. `text` completing ends the utterance; `signal` aborts/closes the session. The server is
  // single-stream (one session at a time); a transient "server busy" on open is the caller's to retry.
  synthesizeSession(
    text: AsyncIterable<string>,
    signal?: AbortSignal,
  ): AsyncIterable<Int16Array>;
}

export interface SpeechPipeline {
  transcriber: Transcriber;
  responder: Responder;
  synthesizer: Synthesizer;
}
