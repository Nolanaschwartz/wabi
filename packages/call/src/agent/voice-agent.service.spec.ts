import { VoiceAgentService } from './voice-agent.service';
import { buildWav } from './audio.util';
import { SpeechPipeline } from './speech';

// A valid 16-bit PCM WAV the real synth path (parseWav -> resampleToMono) can chew on.
const wavOf = (samples = 480) =>
  buildWav(new Int16Array(samples).fill(1), 24000, 1);

// Pipeline that transcribes to a multi-sentence utterance and synth's every chunk.
// rejectChunk: 0-based chunk index whose TTS synth should reject (default: none) — used to
// arm a *prefetched-but-never-awaited* chunk so a leaked promise would surface as unhandled.
const pipelineFor = (reply: string, rejectChunk = -1): SpeechPipeline => {
  let n = 0;
  return {
    transcriber: { transcribe: jest.fn().mockResolvedValue('hey') },
    responder: { respond: jest.fn().mockResolvedValue(reply) },
    synthesizer: {
      synthesize: jest.fn().mockImplementation(async () =>
        n++ === rejectChunk
          ? Promise.reject(new Error('tts blew up'))
          : wavOf(),
      ),
    },
  };
};

// Minimal session: respond() only touches sink, messages, cancel, closed.
const sessionWith = (sink: any) =>
  ({
    sink,
    messages: [{ role: 'system', content: '' }],
    cancel: false,
    closed: false,
  }) as any;

const utt = () => ({ pcm: new Int16Array(160), rate: 16000, channels: 1 }) as any;

describe('VoiceAgentService.respond — prefetch never leaks', () => {
  let rejections: unknown[];
  const onRejection = (r: unknown) => rejections.push(r);

  beforeEach(() => {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => process.off('unhandledRejection', onRejection));

  // Let any unhandled-rejection macrotasks fire before we assert. Node emits
  // 'unhandledRejection' only after the microtask queue drains with no handler attached,
  // so a couple of macrotask turns make a real leak deterministically observable.
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  const make = (pipeline: SpeechPipeline) => {
    const svc = new VoiceAgentService({} as any);
    svc.setPipeline(pipeline);
    return svc;
  };

  it('does not emit an unhandledRejection when sink.write rejects mid-reply', async () => {
    // Arm chunk[1]'s synth to reject. Loop order: prefetch(0) ok -> await -> prefetch(1) [rejects,
    // in flight] -> write(0) rejects -> jump to catch, never awaiting chunk[1]. Without the
    // always-attached .catch, that rejecting prefetch is an unhandledRejection (can crash the call).
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

  it('drains the prefetched chunk when a barge-in (cancel) aborts the loop', async () => {
    const session = sessionWith({
      write: jest.fn().mockImplementation(async () => {
        session.cancel = true; // barge-in after the first chunk plays
      }),
      clear: jest.fn(),
    });
    const svc = make(pipelineFor('One. Two. Three.', 1)); // prefetched chunk[1] rejects

    await (svc as any).respond(session, utt());
    await drain();

    expect(rejections).toEqual([]);
  });

  it('plays every chunk on the clean path and leaks nothing', async () => {
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
    const svc = make(pipelineFor('One. Two. Three.'));

    await (svc as any).respond(sessionWith(sink), utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3);
    expect(rejections).toEqual([]);
  });

  it('still plays the reply when a barge set cancel DURING generation (not playback)', async () => {
    // The detector is suppressed the moment a turn is dispatched, but the assistant isn't actually
    // playing until LLM+TTS finish. A user/noise barge in that window sets session.cancel; without
    // a reset right before playback it stuck true and the whole reply was dropped (never played).
    const sink = { write: jest.fn().mockResolvedValue(undefined), clear: jest.fn() };
    const session = sessionWith(sink);
    const pipeline = pipelineFor('One. Two. Three.');
    (pipeline.responder.respond as jest.Mock).mockImplementation(async () => {
      session.cancel = true; // a barge fires while we're still generating
      return 'One. Two. Three.';
    });
    const svc = make(pipeline);

    await (svc as any).respond(session, utt());
    await drain();

    expect(sink.write).toHaveBeenCalledTimes(3); // reply plays despite the during-generation barge
  });
});
