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
      // NOTE: the server's `stream:true` pcm path produces distorted audio (its CUDA-graph streaming
      // mode); its non-streaming pcm/wav output is clean. So fetch the full sentence (one request per
      // sentence — sentence-level pipelining still overlaps TTS with LLM generation) and yield it once.
      // If the server's streaming path is ever fixed, switch back to chunked reads with stream:true.
      async *synthesizeStream(
        text: string,
        signal?: AbortSignal,
      ): AsyncIterable<Int16Array> {
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
            response_format: 'pcm', // raw 16-bit mono LE @ SYNTH_RATE, no header
          }),
          signal,
        });
        if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const n = bytes.length - (bytes.length % 2);
        if (n <= 0) return;
        const pcm = new Int16Array(n / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
        yield pcm;
      },
    },
  };
}
