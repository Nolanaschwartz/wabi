import { Logger } from '@nestjs/common';
import { AgentConfig, authHeader } from './agent.config';
import { ChatMessage, SpeechPipeline } from './speech';

const ttsLog = new Logger('OpenAiSpeech'); // DIAGNOSTIC: wire tally for the TTS inflation investigation

// OpenAI-compatible adapters for the speech pipeline seam. All knowledge of the wire
// format — multipart fields, /v1 paths, response shapes — is concentrated here.

// Streaming TTS (true) vs buffered (false) — see synthesizeStream. DIAGNOSTIC: streaming temporarily on
// to localize the ~5x audio inflation (wire chunk/byte tally below). Set back to false (buffered, which
// renders correct duration) once the streaming consumer/producer split is settled.
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
        let wireBytes = 0; // DIAGNOSTIC: raw bytes off the wire (== what the server actually sent us)
        let chunks = 0; //   and read() chunk count — cumulative/duplicated framing shows here
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            wireBytes += value.byteLength;
            chunks++;
            const buf = carry.length
              ? Buffer.concat([carry, Buffer.from(value)])
              : Buffer.from(value);
            const usable = buf.length - (buf.length % 2);
            carry = usable < buf.length ? buf.subarray(usable) : Buffer.alloc(0);
            if (usable <= 0) continue;
            yield toSamples(buf.subarray(0, usable));
          }
          // wireBytes/2/24000 = duration RECEIVED. Compare to the server's own emitted-audio log for this
          // request: equal => server sent that much over the wire; server logs less => its send path
          // duplicates/cumulates (chunks/avg-chunk reveal which). input chars pin it to a known request.
          ttsLog.log(
            `tts wire: chars=${text.length} chunks=${chunks} bytes=${wireBytes} ` +
              `received=${(wireBytes / 2 / 24000).toFixed(2)}s`,
          );
        } finally {
          reader.cancel().catch(() => {});
        }
      },
    },
  };
}
