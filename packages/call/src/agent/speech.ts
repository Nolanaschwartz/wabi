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
  respond(messages: ChatMessage[]): Promise<string>;
}

export interface Synthesizer {
  synthesize(text: string): Promise<Buffer>; // returns 16-bit PCM WAV bytes
}

export interface SpeechPipeline {
  transcriber: Transcriber;
  responder: Responder;
  synthesizer: Synthesizer;
}
