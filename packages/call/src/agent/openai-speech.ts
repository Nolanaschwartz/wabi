import { AgentConfig, authHeader } from './agent.config';
import { ChatMessage, SpeechPipeline } from './speech';
import { streamSession, wsSocket } from './streaming-synth';

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
      async *respondStream(
        messages: ChatMessage[],
        signal?: AbortSignal,
      ): AsyncIterable<string> {
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
            max_tokens: cfg.llm.maxTokens, // cap reply length (kept generous; a reasoning model needs
            // headroom or it emits empty text — the respond() loop handles an empty reply fail-open).
            stream: true,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
        if (!res.body) return;

        // Parse the OpenAI SSE stream: lines of `data: {json}`, terminated by `data: [DONE]`.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue; // skip blank lines / comments
              const data = line.slice(5).trim();
              if (data === '[DONE]') return;
              try {
                const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                if (delta) yield delta as string;
              } catch {
                /* keepalive or partial frame — ignore */
              }
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      },
    },

    synthesizer: {
      // Streaming-text TTS: feed reply text in over a WebSocket session, read one continuous PCM stream back.
      // The ws:// URL derives from cfg.tts.url + /v1/audio/stream (the slice-3 server endpoint).
      synthesizeSession(text, signal) {
        return streamSession(
          () => wsSocket(cfg.tts.url),
          { voice: cfg.tts.voice, language: 'Auto', sampleRate: 24000, speed: cfg.tts.speed },
          text,
          signal,
        );
      },
    },
  };
}
