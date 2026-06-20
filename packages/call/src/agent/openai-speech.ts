import { AgentConfig, authHeader } from './agent.config';
import { ChatMessage, SpeechPipeline } from './speech';

// OpenAI-compatible adapters for the speech pipeline seam. All knowledge of the wire
// format — multipart fields, /v1 paths, response shapes — is concentrated here.

export function createOpenAiPipeline(cfg: AgentConfig): SpeechPipeline {
  return {
    transcriber: {
      async transcribe(wav: Buffer): Promise<string> {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
          'audio.wav',
        );
        form.append('model', cfg.stt.model);
        form.append('response_format', 'json');
        const res = await fetch(`${cfg.stt.url}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: authHeader(cfg.stt.key),
          body: form,
        });
        if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
        return (await res.json()).text ?? '';
      },
    },

    responder: {
      async respond(messages: ChatMessage[]): Promise<string> {
        const res = await fetch(`${cfg.llm.url}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeader(cfg.llm.key),
          },
          body: JSON.stringify({
            model: cfg.llm.model,
            messages,
            temperature: 0.6,
          }),
        });
        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
        return (await res.json()).choices?.[0]?.message?.content ?? '';
      },
    },

    synthesizer: {
      async synthesize(text: string): Promise<Buffer> {
        const res = await fetch(`${cfg.tts.url}/v1/audio/speech`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeader(cfg.tts.key),
          },
          body: JSON.stringify({
            model: cfg.tts.model,
            voice: cfg.tts.voice,
            input: text,
            response_format: 'wav',
          }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
        return Buffer.from(await res.arrayBuffer());
      },
    },
  };
}
