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
      // Stream the pcm as it synthesizes (first frame ~0.6s vs full-synth-time): chunked 16-bit mono LE
      // @ SYNTH_RATE. Requires the server's streaming pcm path to be clean (its earlier CUDA-graph
      // streaming mode distorted the audio — fetch buffered pcm if that regresses again).
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
            stream: true,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
        if (!res.body) return;

        // Decode the chunked PCM byte stream into Int16Array frames, carrying a split sample across reads.
        const reader = res.body.getReader();
        let carry: Buffer = Buffer.alloc(0);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const buf = carry.length
              ? Buffer.concat([carry, Buffer.from(value)])
              : Buffer.from(value);
            const usable = buf.length - (buf.length % 2);
            if (usable > 0) {
              const samples = new Int16Array(usable / 2);
              for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
              yield samples;
            }
            carry = usable < buf.length ? buf.subarray(usable) : Buffer.alloc(0);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      },
    },
  };
}
