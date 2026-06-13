import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ClassifierService } from '../classifier.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => (model: any) => ({ _model: model })),
}));

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-classifier',
    apiKey: 'test-key',
  })),
}));

describe('ClassifierService', () => {
  let service: ClassifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClassifierService();
  });

  it('classifies safe message', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    const result = await service.classify('just lost a match, feeling frustrated');
    expect(result).toBe('safe');
    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'test-key',
    });
  });

  it('classifies crisis message', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'crisis' });

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
  });

  it('defaults to crisis on API error (fail-safe)', async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error('network error'));

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
  });

  // Reasoning models (e.g. qwopus-3.6) sometimes return empty content (verdict lives in a separate
  // reasoning channel, or the budget is exhausted). Empty MUST fail safe to crisis — failing open to
  // 'safe' silently lets real crises through. Pairs with the larger output budget below, which makes
  // empty verdicts rare in the first place.
  it('treats empty model output as crisis (fail-safe, not fail-open)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '' });

    const result = await service.classify('I want to end it all');
    expect(result).toBe('crisis');
  });

  it('treats blank/whitespace output as crisis (fail-safe)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: '   \n ' });

    const result = await service.classify('anything');
    expect(result).toBe('crisis');
  });

  it('treats unparseable response as crisis (fail-safe)', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'probably fine' });

    const result = await service.classify('I had a rough day');
    expect(result).toBe('crisis');
  });

  it('returns safe only on an explicit safe verdict', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    const result = await service.classify('just lost a match');
    expect(result).toBe('safe');
  });

  // Reasoning models burn output tokens before emitting the verdict; a 10-token cap left content
  // empty for every message. The budget must be large enough for the model to finish reasoning and
  // still print "safe"/"crisis" (256 was the reliable floor against qwopus-3.6).
  it('requests an output budget large enough for reasoning models to emit a verdict', async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

    await service.classify('hello');

    const callArgs = (generateText as jest.Mock).mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBeGreaterThanOrEqual(256);
  });

  // Context-blind classification was the root cause of a tilt-session false positive: the bare phrase
  // "it's not helping" (a reply to a breathing technique) tripped the fail-closed bias to 'crisis'.
  // The classifier now accepts optional conversation context so the model can disambiguate — WITHOUT
  // weakening the fail-closed floor.
  describe('disambiguation context', () => {
    it('always wraps the message in a uniform envelope, even with no context', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      await service.classify('just lost a match');

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      // Uniform shape on every call — the cold path is wrapped too, not bare.
      expect(callArgs.prompt).toContain('Message to classify:');
      expect(callArgs.prompt).toContain('just lost a match');
      // No spurious context block when there is nothing to add.
      expect(callArgs.prompt).not.toContain('Conversation context');
    });

    it('tells the model an active tilt session frames the message as technique-feedback', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      await service.classify("it's not helping", { inTiltSession: true });

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      // The message is still classified, but now carried inside disambiguating context.
      expect(callArgs.prompt).toContain("it's not helping");
      expect(callArgs.prompt.toLowerCase()).toContain('tilt');
    });

    it('includes recent turns so a reply lands against what the bot just said', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      await service.classify("it's not helping", {
        recentTurns: [{ role: 'assistant', content: 'Try the 4-7-8 breathing technique' }],
      });

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      expect(callArgs.prompt).toContain('4-7-8 breathing');
    });

    it('clamps a long conversation to the most recent user messages (keeps interleaved bot turns)', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      const turns: Array<{ role: string; content: string }> = [];
      for (let i = 1; i <= 8; i++) {
        turns.push({ role: 'user', content: `user-msg-${i}` });
        turns.push({ role: 'assistant', content: `bot-reply-${i}` });
      }

      await service.classify('latest reply', { recentTurns: turns });

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      // The 5 most recent user messages survive...
      expect(callArgs.prompt).toContain('user-msg-8');
      expect(callArgs.prompt).toContain('user-msg-4');
      // ...older ones are dropped so a long session can't bloat the safety prompt.
      expect(callArgs.prompt).not.toContain('user-msg-3');
      expect(callArgs.prompt).not.toContain('user-msg-1');
      // Interleaved bot turns inside the window are kept — they hold the disambiguator.
      expect(callArgs.prompt).toContain('bot-reply-7');
    });

    it('carves out "a coping technique is not working" as safe in the system prompt', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      await service.classify('hello');

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      expect(callArgs.system.toLowerCase()).toContain('technique');
    });

    it('keeps failing safe to crisis even with context (fail-closed is unconditional — ADR-0021)', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: '' });

      const result = await service.classify("it's not helping", { inTiltSession: true });

      expect(result).toBe('crisis');
    });

    it('an empty context object wraps without a context block (no spurious framing)', async () => {
      (generateText as jest.Mock).mockResolvedValue({ text: 'safe' });

      await service.classify('just venting', {});

      const callArgs = (generateText as jest.Mock).mock.calls[0][0];
      expect(callArgs.prompt).toContain('Message to classify:');
      expect(callArgs.prompt).toContain('just venting');
      expect(callArgs.prompt).not.toContain('Conversation context');
    });
  });
});
