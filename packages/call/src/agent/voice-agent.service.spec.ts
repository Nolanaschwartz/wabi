import { VoiceAgentService } from './voice-agent.service';
import { buildWav } from './audio.util';
import { SpeechPipeline } from './speech';

// A valid 16-bit PCM WAV the real synth path (parseWav -> resampleToMono) can chew on.
const wavOf = (samples = 480) =>
  buildWav(new Int16Array(samples).fill(1), 24000, 1);

// A responder.respondStream mock that yields the given text deltas in order.
const streamOf = (...deltas: string[]) =>
  jest.fn().mockImplementation(async function* () {
    for (const d of deltas) yield d;
  });

// Pipeline whose responder streams `reply` (as one delta) and synth's every sentence.
// rejectChunk: 0-based synth call whose TTS should reject (default: none) — used to arm a
// *prefetched-but-never-awaited* chunk so a leaked promise would surface as unhandled.
const pipelineFor = (reply: string, rejectChunk = -1): SpeechPipeline => {
  let n = 0;
  return {
    transcriber: { transcribe: jest.fn().mockResolvedValue('hey') },
    responder: { respondStream: streamOf(reply) },
    synthesizer: {
      synthesize: jest.fn().mockImplementation(async () =>
        n++ === rejectChunk
          ? Promise.reject(new Error('tts blew up'))
          : wavOf(),
      ),
    },
  } as unknown as SpeechPipeline;
};

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

  // Let any unhandled-rejection macrotasks fire before we assert.
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('plays every sentence in order on the clean path and leaks nothing', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
    const svc = make(pipelineFor('One. Two. Three.'));

    await (svc as any).respond(sessionWith(sink), utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3);
    expect(rejections).toEqual([]);
  });

  it('assembles sentences that span multiple stream deltas', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
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

  it('does not emit an unhandledRejection when sink.write rejects mid-reply', async () => {
    // chunk[1]'s synth is prefetched then never awaited once sink.write rejects and we jump to catch.
    const sink = {
      write: jest.fn().mockRejectedValue(new Error('sink torn down')),
      clear: jest.fn(),
    };
    const svc = make(pipelineFor('One. Two. Three.', 1));

    await expect(
      (svc as any).respond(sessionWith(sink), utt()),
    ).resolves.toBeUndefined();
    await drain();

    expect(rejections).toEqual([]);
  });

  it('drains the prefetched chunk when a barge-in (cancel) aborts playback', async () => {
    const session = sessionWith({
      write: jest.fn().mockImplementation(async () => {
        session.cancel = true; // barge-in after the first sentence plays
      }),
      clear: jest.fn(),
    });
    const svc = make(pipelineFor('One. Two. Three.', 1)); // prefetched chunk[1] rejects

    await (svc as any).respond(session, utt());
    await drain();

    expect(rejections).toEqual([]);
  });

  it('clears a barge that fired during STT so the reply still plays', async () => {
    // A barge while transcribing (assistant not audible yet) must not drop the reply: respond resets
    // cancel after STT, so only a barge during playback stops it.
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('One. Two. Three.');
    (pipeline.transcriber.transcribe as jest.Mock).mockImplementation(async () => {
      session.cancel = true; // a barge fires mid-transcription
      return 'hey';
    });
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3);
  });

  it('settles when a TTS synth call hangs, so the detector is never stranded', async () => {
    jest.useFakeTimers();
    try {
      const pipeline = pipelineFor('One. Two.');
      (pipeline.synthesizer.synthesize as jest.Mock).mockReturnValue(
        new Promise(() => {}), // never resolves
      );
      const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
      const svc = make(pipeline);

      let settled = false;
      void (svc as any).respond(sessionWith(sink), utt()).then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(20_000); // past the 15s TTS timeout
      expect(settled).toBe(true);
      expect(sink.write).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles when the LLM stream stalls (idle timeout), never stranding the detector', async () => {
    jest.useFakeTimers();
    try {
      const pipeline = pipelineFor('x');
      // A stream whose first token never arrives.
      pipeline.responder.respondStream = jest.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      });
      const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
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
