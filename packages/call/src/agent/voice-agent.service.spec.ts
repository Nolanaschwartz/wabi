import { Logger } from '@nestjs/common';
import { VoiceAgentService } from './voice-agent.service';
import { SpeechPipeline } from './speech';

// A responder.respondStream mock that yields the given text deltas in order.
const streamOf = (...deltas: string[]) =>
  jest.fn().mockImplementation(async function* () {
    for (const d of deltas) yield d;
  });

// A synthesizer.synthesizeStream mock that yields `frames` PCM frames per call.
const pcmStreamer = (frames = 1, samples = 240) =>
  jest.fn().mockImplementation(async function* () {
    for (let i = 0; i < frames; i++) yield new Int16Array(samples).fill(1);
  });

// Pipeline: streams `reply` as one delta, transcribes to a fixed utterance, streams 1 PCM frame/sentence.
const pipelineFor = (reply: string): SpeechPipeline =>
  ({
    transcriber: { transcribe: jest.fn().mockResolvedValue('hey') },
    responder: { respondStream: streamOf(reply) },
    synthesizer: { synthesizeStream: pcmStreamer(1) },
  }) as unknown as SpeechPipeline;

// Minimal session: respond() only touches sink, messages, cancel, closed, abort.
const sessionWith = (sink: any) =>
  ({
    sink,
    messages: [{ role: 'system', content: '' }],
    cancel: false,
    closed: false,
  }) as any;

const utt = () => ({ pcm: new Int16Array(160), rate: 16000, channels: 1 }) as any;

const make = (pipeline: SpeechPipeline) => {
  const svc = new VoiceAgentService({} as any);
  svc.setPipeline(pipeline);
  return svc;
};

describe('VoiceAgentService.respond — streaming playback', () => {
  let rejections: unknown[];
  const onRejection = (r: unknown) => rejections.push(r);

  beforeEach(() => {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => process.off('unhandledRejection', onRejection));

  const drain = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('plays every sentence in order on the clean path and leaks nothing', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    const svc = make(pipelineFor('One. Two. Three.'));

    await (svc as any).respond(sessionWith(sink), utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3); // 1 PCM frame per sentence
    expect(rejections).toEqual([]);
  });

  it('assembles sentences that span multiple stream deltas', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = streamOf('Hello the', 're. How ', 'are you?');
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(2); // "Hello there." + "How are you?"
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Hello there. How are you?',
    });
  });

  it('plays sentence 1 without waiting for sentence 2 to be generated', async () => {
    // Regression: first audio must not wait a sentence behind. Sentence 1 should stream+play as soon
    // as it forms, even while the LLM is still (slowly) generating sentence 2.
    let releaseSecond!: () => void;
    const gate = new Promise<void>((r) => (releaseSecond = r));
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = jest.fn().mockImplementation(async function* () {
      yield 'One. ';
      await gate; // sentence 2 is withheld
      yield 'Two.';
    });
    const svc = make(pipeline);

    const done = (svc as any).respond(sessionWith(sink), utt());
    await drain();
    await drain();
    expect(sink.write).toHaveBeenCalledTimes(1); // sentence 1 played before sentence 2 existed

    releaseSecond();
    await done;
    expect(sink.write).toHaveBeenCalledTimes(2);
  });

  it('settles without leaking when sink.write rejects mid-reply', async () => {
    const sink = {
      write: jest.fn().mockRejectedValue(new Error('sink torn down')),
      clear: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    };
    const svc = make(pipelineFor('One. Two. Three.'));

    await expect(
      (svc as any).respond(sessionWith(sink), utt()),
    ).resolves.toBeUndefined();
    await drain();

    expect(rejections).toEqual([]);
  });

  it('stops cleanly when a barge-in (cancel) aborts playback', async () => {
    const session = sessionWith({
      write: jest.fn().mockImplementation(async () => {
        session.cancel = true; // barge-in after the first frame plays
      }),
      clear: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    });
    const svc = make(pipelineFor('One. Two. Three.'));

    await (svc as any).respond(session, utt());
    await drain();

    expect(rejections).toEqual([]);
  });

  it('clears a barge that fired during STT so the reply still plays', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('One. Two. Three.');
    (pipeline.transcriber.transcribe as jest.Mock).mockImplementation(async () => {
      session.cancel = true; // a barge fires mid-transcription (assistant not audible yet)
      return 'hey';
    });
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3);
  });

  it('settles when a TTS stream stalls, so the detector is never stranded', async () => {
    jest.useFakeTimers();
    try {
      const pipeline = pipelineFor('One. Two.');
      // A synth stream whose first frame never arrives.
      pipeline.synthesizer.synthesizeStream = jest.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      });
      const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
      const svc = make(pipeline);

      let settled = false;
      void (svc as any).respond(sessionWith(sink), utt()).then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(20_000); // past the 15s TTS idle timeout
      expect(settled).toBe(true);
      expect(sink.write).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits exactly one structured latency line per turn on the clean path', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
      logs.push(String(m));
    });
    try {
      const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
      const svc = make(pipelineFor('One. Two. Three.'));

      await (svc as any).respond(sessionWith(sink), utt());
      await drain();

      const latency = logs.filter((l) => l.startsWith('latency '));
      expect(latency).toHaveLength(1);
      expect(latency[0]).toMatch(/^latency stt=\d+ms llm_ttft=\d+ms sent1=\d+ms tts_first=\d+ms first_audio=\d+ms total=\d+ms$/);
    } finally {
      spy.mockRestore();
    }
  });

  it('emits no latency line when a barge-in cancels the turn', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
      logs.push(String(m));
    });
    try {
      const session = sessionWith({
        write: jest.fn().mockImplementation(async () => {
          session.cancel = true; // barge-in after the first frame plays
        }),
        clear: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      });
      const svc = make(pipelineFor('One. Two. Three.'));

      await (svc as any).respond(session, utt());
      await drain();

      expect(logs.filter((l) => l.startsWith('latency '))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('settles when the LLM stream stalls (idle timeout), never stranding the detector', async () => {
    jest.useFakeTimers();
    try {
      const pipeline = pipelineFor('x');
      pipeline.responder.respondStream = jest.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      });
      const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
      const svc = make(pipeline);

      let settled = false;
      void (svc as any).respond(sessionWith(sink), utt()).then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(31_000); // past the 30s LLM idle timeout
      expect(settled).toBe(true);
      expect(sink.write).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
