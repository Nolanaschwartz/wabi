import { AgentConfig, authHeader } from './agent.config';
import { ChatMessage, SpeechPipeline } from './speech';
import { streamSession, wsSocket } from './streaming-synth';

// OpenAI-compatible adapters for the speech pipeline seam. All knowledge of the wire
// format — multipart fields, /v1 paths, response shapes — is concentrated here.

// Streaming TTS (true) vs buffered (false) — see synthesizeStream. Streaming yields first audio ~0.2s in
// vs waiting ~RTF*duration for the whole clip. The server's streaming over-generation (missing
// repetition penalty) is fixed in the TTS fork's stream_generate_pcm, so streaming is the default again.
const STREAM_TTS = true;

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
      // Approach B: feed reply text in over a WebSocket session, read one continuous PCM stream back.
      // The ws:// URL derives from cfg.tts.url + /v1/audio/stream (the slice-3 server endpoint).
      synthesizeSession(text, signal) {
        return streamSession(
          () => wsSocket(cfg.tts.url),
          { voice: cfg.tts.voice, language: 'Auto', sampleRate: 24000, speed: cfg.tts.speed },
          text,
          signal,
        );
      },
      // STREAM_TTS=true: stream raw PCM chunk-by-chunk (first frame ~0.2s in). But the server emits
      // STRETCHED, over-long audio for SHORT inputs in streaming mode (measured ~2–4x; long replies are
      // ~correct) — that's the dragging voice. false: buffered — render the whole clip server-side and
      // yield it once, correct duration, no drag, at the cost of waiting ~RTF*duration for the first
      // sample (and a long reply can blow the per-frame TTS idle timeout). Compare via synth_audio in the
      // per-turn log. ponytail: kept the flag because this exact knob has flip-flopped — A/B by ear.
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
            speed: cfg.tts.speed, // pace the voice (PENDING: verify the server honors this field live)
            response_format: 'pcm', // raw 16-bit mono LE @ SYNTH_RATE, no header
            stream: STREAM_TTS,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
        if (!res.body) return;

        const toSamples = (buf: Buffer): Int16Array => {
          const n = buf.length >> 1; // drop any trailing odd byte
          const out = new Int16Array(n);
          for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
          return out;
        };

        if (!STREAM_TTS) {
          yield toSamples(Buffer.from(await res.arrayBuffer())); // whole clip in one shot
          return;
        }

        const reader = res.body.getReader();
        let carry: Buffer = Buffer.alloc(0); // trailing odd byte from the previous chunk
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const buf = carry.length
              ? Buffer.concat([carry, Buffer.from(value)])
              : Buffer.from(value);
            const usable = buf.length - (buf.length % 2);
            carry = usable < buf.length ? buf.subarray(usable) : Buffer.alloc(0);
            if (usable <= 0) continue;
            yield toSamples(buf.subarray(0, usable));
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      },
    },
  };
}
