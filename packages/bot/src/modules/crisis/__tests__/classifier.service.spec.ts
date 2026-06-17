// ClassifierService is now a caller of @wabi/shared/generate: build the safety prompt -> generate ->
// map result to a fail-CLOSED verdict. The MECHANISM (lazy provider resolution, the ai client, the
// call) moved into generate (ADR-0037); what stays here and is tested is the classifier's DOMAIN
// logic — the context-envelope builder + MAX_CONTEXT_USER_MESSAGES clamp — and, above all, its
// fail-closed policy (ADR-0021): only an explicit, unambiguous "safe" is safe; empty output, an
// unparseable verdict, OR a thrown call all resolve to 'crisis', logged so the failure stays
// diagnosable. generate THROWS only on a transport error; empty output reaches us as empty `text`.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { ClassifierService } from '../classifier.service';

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };

// generate returns { text, usage?, model, latencyMs }; the classifier reads only `text`.
const reply = (text: string) => ({ text, usage: undefined, model: 'test-classifier', latencyMs: 1 });

describe('ClassifierService', () => {
  let service: ClassifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClassifierService();
  });

  it('classifies safe message', async () => {
    generate.mockResolvedValue(reply('safe'));

    const result = await service.classify('just lost a match, feeling frustrated');
    expect(result).toBe('safe');
  });

  it('classifies crisis message', async () => {
    generate.mockResolvedValue(reply('crisis'));

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
  });

  it('defaults to crisis when generate throws (transport failure, fail-closed & logged)', async () => {
    const errSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    generate.mockRejectedValue(new Error('network error'));

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
    expect(errSpy).toHaveBeenCalled();
  });

  // Reasoning models (e.g. qwopus-3.6) sometimes return empty content. With generate, an empty result
  // is NOT a throw — it arrives as empty `text`. Empty MUST fail CLOSED to crisis via the "no explicit
  // safe -> crisis" branch, independent of the transport-error path. Logged so it stays diagnosable.
  it('treats empty model output as crisis (fail-closed, not fail-open) and logs it', async () => {
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    generate.mockResolvedValue(reply(''));

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('treats blank/whitespace output as crisis (fail-closed)', async () => {
    generate.mockResolvedValue(reply('   \n '));

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
  });

  it('treats unparseable response as crisis (fail-closed) and logs it', async () => {
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    generate.mockResolvedValue(reply('probably fine'));

    const result = await service.classify('I had a rough day');
    expect(result).toBe('crisis');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns safe only on an explicit safe verdict', async () => {
    generate.mockResolvedValue(reply('safe'));

    const result = await service.classify('just lost a match');
    expect(result).toBe('safe');
  });

  it('calls generate with role "classifier", temperature 0, a 512 cap, and NO retry-on-empty', async () => {
    generate.mockResolvedValue(reply('safe'));

    await service.classify('hello');

    expect(generate.mock.calls[0][0]).toBe('classifier');
    const opts = generate.mock.calls[0][1];
    expect(opts.temperature).toBe(0);
    expect(opts.maxOutputTokens).toBe(512);
    // The safety path fails closed instantly — no added latency from a retry.
    expect(opts.retryOnEmpty).toBeUndefined();
  });

  // Context-blind classification was the root cause of a tilt-session false positive: the bare phrase
  // "it's not helping" (a reply to a breathing technique) tripped the fail-closed bias to 'crisis'.
  // The classifier accepts optional conversation context so the model can disambiguate — WITHOUT
  // weakening the fail-closed floor.
  describe('disambiguation context', () => {
    it('always wraps the message in a uniform envelope, even with no context', async () => {
      generate.mockResolvedValue(reply('safe'));

      await service.classify('just lost a match');

      const opts = generate.mock.calls[0][1];
      // Uniform shape on every call — the cold path is wrapped too, not bare.
      expect(opts.prompt).toContain('Message to classify:');
      expect(opts.prompt).toContain('just lost a match');
      // No spurious context block when there is nothing to add.
      expect(opts.prompt).not.toContain('Conversation context');
    });

    it('tells the model an active tilt session frames the message as technique-feedback', async () => {
      generate.mockResolvedValue(reply('safe'));

      await service.classify("it's not helping", { inTiltSession: true });

      const opts = generate.mock.calls[0][1];
      expect(opts.prompt).toContain("it's not helping");
      expect(opts.prompt.toLowerCase()).toContain('tilt');
    });

    it('includes recent turns so a reply lands against what the bot just said', async () => {
      generate.mockResolvedValue(reply('safe'));

      await service.classify("it's not helping", {
        recentTurns: [{ role: 'assistant', content: 'Try the 4-7-8 breathing technique' }],
      });

      const opts = generate.mock.calls[0][1];
      expect(opts.prompt).toContain('4-7-8 breathing');
    });

    it('clamps a long conversation to the most recent user messages (keeps interleaved bot turns)', async () => {
      generate.mockResolvedValue(reply('safe'));

      const turns: Array<{ role: string; content: string }> = [];
      for (let i = 1; i <= 8; i++) {
        turns.push({ role: 'user', content: `user-msg-${i}` });
        turns.push({ role: 'assistant', content: `bot-reply-${i}` });
      }

      await service.classify('latest reply', { recentTurns: turns });

      const opts = generate.mock.calls[0][1];
      // The 5 most recent user messages survive...
      expect(opts.prompt).toContain('user-msg-8');
      expect(opts.prompt).toContain('user-msg-4');
      // ...older ones are dropped so a long session can't bloat the safety prompt.
      expect(opts.prompt).not.toContain('user-msg-3');
      expect(opts.prompt).not.toContain('user-msg-1');
      // Interleaved bot turns inside the window are kept — they hold the disambiguator.
      expect(opts.prompt).toContain('bot-reply-7');
    });

    it('carves out "a coping technique is not working" as safe in the system prompt', async () => {
      generate.mockResolvedValue(reply('safe'));

      await service.classify('hello');

      const opts = generate.mock.calls[0][1];
      expect(opts.system.toLowerCase()).toContain('technique');
    });

    it('keeps failing closed to crisis even with context (fail-closed is unconditional — ADR-0021)', async () => {
      generate.mockResolvedValue(reply(''));

      const result = await service.classify("it's not helping", { inTiltSession: true });

      expect(result).toBe('crisis');
    });

    it('an empty context object wraps without a context block (no spurious framing)', async () => {
      generate.mockResolvedValue(reply('safe'));

      await service.classify('just venting', {});

      const opts = generate.mock.calls[0][1];
      expect(opts.prompt).toContain('Message to classify:');
      expect(opts.prompt).toContain('just venting');
      expect(opts.prompt).not.toContain('Conversation context');
    });
  });
});
