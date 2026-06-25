import { Logger } from '@nestjs/common';
import { VoiceAgentService } from './voice-agent.service';
import { SpeechPipeline } from './speech';
import { TurnTimer } from './turn-timer';

// A fake streaming-session synthesizer (the only synth path): consumes the text iterable, yields one PCM
// frame per delta. Captures the text it received so tests can assert the deltas were streamed in.
const sessionSynth = () =>
  jest.fn((text: AsyncIterable<string>) =>
    (async function* () {
      for await (const _ of text) yield new Int16Array(2).fill(1);
    })(),
  );

// A responder.respondStream mock that yields the given text deltas in order.
const streamOf = (...deltas: string[]) =>
  jest.fn().mockImplementation(async function* () {
    for (const d of deltas) yield d;
  });

// Pipeline: streams `reply` as one delta, transcribes to a fixed utterance, synthesizes over one session.
const pipelineFor = (reply: string): SpeechPipeline =>
  ({
    transcriber: { transcribe: jest.fn().mockResolvedValue('hey') },
    responder: { respondStream: streamOf(reply) },
    synthesizer: { synthesizeSession: sessionSynth() },
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
  const svc = new VoiceAgentService();
  svc.setPipeline(pipeline);
  return svc;
};

describe('VoiceAgentService.respond — streaming-session playback', () => {
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

  it('synthesizes the reply over one streaming session and leaks nothing', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() };
    const pipeline = pipelineFor('One. Two. Three.');
    const svc = make(pipeline);

    await (svc as any).respond(sessionWith(sink), utt());
    await drain();

    expect(pipeline.synthesizer.synthesizeSession).toHaveBeenCalledTimes(1);
    expect(sink.write).toHaveBeenCalledTimes(1); // one delta -> one frame
    expect(rejections).toEqual([]);
  });

  it('streams reply deltas into one session and pipes PCM to the sink', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = streamOf('Hello ', 'there. ', 'How are you?');
    pipeline.synthesizer.synthesizeSession = sessionSynth();
    const svc = make(pipeline);

    await (svc as any).respondViaSession(session, new AbortController(), new TurnTimer());

    expect(pipeline.synthesizer.synthesizeSession).toHaveBeenCalledTimes(1);
    expect(sink.clear).toHaveBeenCalled(); // dropped the prior reply before the first write
    expect(sink.write).toHaveBeenCalledTimes(3); // one PCM frame per streamed delta
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Hello there. How are you?', // full reply accumulated for history
    });
  });

  it('a barge during playback stops writing', async () => {
    const session = sessionWith({
      write: jest.fn().mockImplementation(() => {
        session.cancel = true; // barge after the first frame
      }),
      clear: jest.fn(),
    });
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = streamOf('a ', 'b ', 'c ', 'd');
    pipeline.synthesizer.synthesizeSession = sessionSynth();
    const svc = make(pipeline);

    await (svc as any).respondViaSession(session, new AbortController(), new TurnTimer());

    expect(session.sink.write).toHaveBeenCalledTimes(1); // stopped after the barge
  });

  it('retries a "server busy" session and succeeds', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = streamOf('Hi ', 'there.');
    let calls = 0;
    pipeline.synthesizer.synthesizeSession = jest.fn((text: AsyncIterable<string>) => {
      calls += 1;
      if (calls === 1)
        return (async function* (): AsyncIterable<Int16Array> {
          throw new Error('tts session: server busy: one stream at a time');
        })();
      return (async function* () {
        for await (const _ of text) yield new Int16Array(2).fill(1);
      })();
    });
    const svc = make(pipeline);

    await (svc as any).respondViaSession(session, new AbortController(), new TurnTimer());

    expect(calls).toBe(2); // first stream was busy, retried once
    expect(sink.write).toHaveBeenCalled(); // second attempt produced audio
    expect(session.messages.at(-1)).toEqual({ role: 'assistant', content: 'Hi there.' });
  }, 10000);

  it('warms STT/LLM/TTS connections, draining each, fail-open', async () => {
    const pipeline = pipelineFor('hi');
    // STT endpoint cold: warm-up must still resolve (fail-open).
    (pipeline.transcriber.transcribe as jest.Mock).mockRejectedValue(new Error('cold'));
    const svc = make(pipeline);

    await expect((svc as any).warmUp()).resolves.toBeUndefined();

    expect(pipeline.transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(pipeline.responder.respondStream).toHaveBeenCalledTimes(1);
    expect(pipeline.synthesizer.synthesizeSession).toHaveBeenCalledTimes(1);
  });

  it('downsamples the utterance to 16kHz mono before STT', async () => {
    let sentWav: Buffer | undefined;
    const pipeline = pipelineFor('hi');
    (pipeline.transcriber.transcribe as jest.Mock).mockImplementation(async (wav: Buffer) => {
      sentWav = wav;
      return 'hey';
    });
    const svc = make(pipeline);
    // 48kHz stereo capture (Discord native) — must reach STT as 16kHz mono.
    const utt48 = { pcm: new Int16Array(4800).fill(1000), rate: 48000, channels: 2 } as any;

    await (svc as any).respond(sessionWith({ write: jest.fn(), clear: jest.fn() }), utt48);

    expect(sentWav).toBeDefined();
    // Read the WAV header directly (channels @22, sample-rate @24 — buildWav's fixed 44-byte layout).
    expect(sentWav!.readUInt16LE(22)).toBe(1); // mono
    expect(sentWav!.readUInt32LE(24)).toBe(16000); // 16kHz
  });

  it('accumulates the full reply across multiple stream deltas', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('x');
    pipeline.responder.respondStream = streamOf('Hello the', 're. How ', 'are you?');
    pipeline.synthesizer.synthesizeSession = sessionSynth();
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3); // one frame per delta
    // clear() drops any leftover from the prior reply before this one queues, so playout can't fall
    // behind across turns. Must fire before the first write, else the reply's own audio is dropped.
    expect(sink.clear).toHaveBeenCalled();
    expect(sink.clear.mock.invocationCallOrder[0]).toBeLessThan(
      sink.write.mock.invocationCallOrder[0],
    );
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Hello there. How are you?',
    });
  });

  it('settles without leaking when sink.write throws mid-reply', async () => {
    const sink = {
      write: jest.fn(() => {
        throw new Error('sink torn down');
      }),
      clear: jest.fn(),
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
    });
    const svc = make(pipelineFor('One. Two. Three.'));

    await (svc as any).respond(session, utt());
    await drain();

    expect(rejections).toEqual([]);
  });

  it('clears a barge that fired during STT so the reply still plays', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('One. Two. Three.');
    (pipeline.transcriber.transcribe as jest.Mock).mockImplementation(async () => {
      session.cancel = true; // a barge fires mid-transcription (assistant not audible yet)
      return 'hey';
    });
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(1); // whole reply -> one session -> one frame, still plays
  });

  it('settles when a session TTS stream stalls, so the detector is never stranded', async () => {
    jest.useFakeTimers();
    try {
      const pipeline = pipelineFor('One. Two.');
      // A session whose first PCM frame never arrives.
      pipeline.synthesizer.synthesizeSession = jest.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      });
      const sink = { write: jest.fn(), clear: jest.fn() };
      const svc = make(pipeline);

      let settled = false;
      void (svc as any).respond(sessionWith(sink), utt()).then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(36_000); // past the 35s session TTS idle timeout
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
      const sink = { write: jest.fn(), clear: jest.fn() };
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
      const sink = { write: jest.fn(), clear: jest.fn() };
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

// Slice 6: the detector stays suppressed through the playout tail (after synth receipt but while audio
// is still queued in the bridge's outBuf), and un-suppresses only when playout actually DRAINS. Wired in
// feed(): respond().finally() arms the drain gate; setSuppressed(false) waits on sink.whenDrained().
describe('VoiceAgentService.feed — drain-gated un-suppress (barge-in playout tail)', () => {
  // A fake detector that lets us drive one utterance through feed() and watch suppress/un-suppress.
  const fakeDetector = () => ({ setSuppressed: jest.fn(), push: jest.fn() });

  // Seat a session directly (bypassing start(), which needs config + real pipeline) and hand back the
  // injected detector so the test can assert on the suppress calls feed() makes.
  const seatSession = (svc: VoiceAgentService, sink: any) => {
    const detector = fakeDetector();
    (svc as any).sessions.set('g', {
      sink,
      detector,
      messages: [{ role: 'system', content: '' }],
      cancel: false,
      closed: false,
    });
    return detector;
  };

  const drive = (svc: VoiceAgentService, detector: any) => {
    detector.push.mockReturnValueOnce({ utterance: utt() });
    detector.push.mockReturnValue(null);
    (svc as any).feed('g', new Int16Array(160), 16000, 1);
  };

  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('stays suppressed until playout drains, then un-suppresses', async () => {
    let resolveDrain!: () => void;
    const drained = new Promise<void>((r) => (resolveDrain = r));
    const sink = {
      write: jest.fn(),
      clear: jest.fn(),
      whenDrained: jest.fn().mockReturnValue(drained),
    };
    const svc = make(pipelineFor('One. Two. Three.'));
    const detector = seatSession(svc, sink);

    drive(svc, detector);
    expect(detector.setSuppressed).toHaveBeenCalledWith(true);

    await tick();
    // respond() has finished (synth received) but playout has NOT drained: still suppressed.
    expect(sink.whenDrained).toHaveBeenCalled();
    expect(detector.setSuppressed).not.toHaveBeenCalledWith(false);

    resolveDrain();
    await tick();
    // drained -> un-suppress
    expect(detector.setSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('never strands the detector suppressed if drain never signals (safety timeout)', async () => {
    jest.useFakeTimers();
    try {
      const sink = {
        write: jest.fn(),
        clear: jest.fn(),
        whenDrained: jest.fn().mockReturnValue(new Promise<void>(() => {})), // never resolves
      };
      const svc = make(pipelineFor('One. Two.'));
      const detector = seatSession(svc, sink);

      drive(svc, detector);
      await jest.advanceTimersByTimeAsync(30_000); // past the drain safety timeout
      expect(detector.setSuppressed).toHaveBeenLastCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('un-suppresses immediately when the sink exposes no drain signal (test fakes)', async () => {
    const sink = { write: jest.fn(), clear: jest.fn() }; // no whenDrained
    const svc = make(pipelineFor('One.'));
    const detector = seatSession(svc, sink);

    drive(svc, detector);
    await tick();
    expect(detector.setSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('a barge during the playout tail cuts the assistant (clears queued audio)', async () => {
    // Drain stays pending: the assistant is mid-tail, still suppressed and watching for a barge.
    const sink = {
      write: jest.fn(),
      clear: jest.fn(),
      whenDrained: jest.fn().mockReturnValue(new Promise<void>(() => {})),
    };
    const svc = make(pipelineFor('One. Two. Three.'));
    const detector = seatSession(svc, sink);

    drive(svc, detector); // first feed -> utterance, arms the (still-pending) drain gate
    await tick();
    expect(detector.setSuppressed).not.toHaveBeenCalledWith(false); // still suppressed in the tail

    // Now sustained tail speech trips a barge; feed() must cut the queued assistant audio.
    detector.push.mockReturnValueOnce({ barge: true });
    (svc as any).feed('g', new Int16Array(160), 16000, 1);
    expect(sink.clear).toHaveBeenCalled(); // assistant audio dropped -> playout cut
  });
});
