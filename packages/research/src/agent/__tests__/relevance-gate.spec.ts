// relevanceGate is now a caller of the injected `gen` seam (not @wabi/shared/generate directly): build
// prompt -> gen('gate', 'research-triage', ...) -> map result. The MECHANISM (role→cap binding, provider
// resolution, the call, span emission) lives in `gen`; what stays here and is tested is the gate's
// DOMAIN logic — the "no" parse, topic/scope wording, role/span, and its fail-OPEN policy (error/empty -> keep).
import { relevanceGate } from '../relevance-gate';
import { SCOPE_FRAGMENT } from '../scope-policy';
import type { ResearchGenerate } from '../research-generate';
import type { GenerateResult } from '@wabi/shared/generate';

describe('relevanceGate', () => {
  // A fake `gen`: returns a canned GenerateResult, recording how the gate called it.
  const reply = (text: string, totalTokens?: number): GenerateResult => ({
    text,
    usage: totalTokens === undefined ? undefined : { totalTokens },
    model: 'm',
    latencyMs: 1,
  });
  const genReturning = (r: GenerateResult): jest.MockedFunction<ResearchGenerate> =>
    jest.fn().mockResolvedValue(r) as jest.MockedFunction<ResearchGenerate>;

  it('keeps an on-topic abstract', async () => {
    const gen = genReturning(reply('yes', 5));
    const r = await relevanceGate(gen, 'Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract', async () => {
    const gen = genReturning(reply('no', 4));
    expect((await relevanceGate(gen, 'A study of knee cartilage repair.', 'tilt')).keep).toBe(false);
  });

  it('keeps a transferable-mechanism abstract for the topic', async () => {
    const gen = genReturning(reply('yes', 5));
    expect((await relevanceGate(gen, 'Implementation intentions improved habit follow-through.', 'motivation')).keep).toBe(true);
  });

  it('drops a supplement/clinical abstract at the gate', async () => {
    const gen = genReturning(reply('no', 4));
    expect((await relevanceGate(gen, 'Vitamin D supplementation improved mood.', 'mood')).keep).toBe(false);
  });

  it('prompts with the run topic and the shared scope fragment', async () => {
    const gen = genReturning(reply('yes', 5));
    await relevanceGate(gen, 'abstract body', 'rumination');
    const prompt: string = gen.mock.calls[0][2].prompt;
    expect(prompt).toContain('rumination');
    expect(prompt).toContain(SCOPE_FRAGMENT);
  });

  it('calls gen with span "gate", role "research-triage", and is deterministic (temp 0)', async () => {
    const gen = genReturning(reply('yes', 5));
    await relevanceGate(gen, 'x', 'topic');
    expect(gen.mock.calls[0][0]).toBe('gate');
    expect(gen.mock.calls[0][1]).toBe('research-triage');
    expect(gen.mock.calls[0][2].temperature).toBe(0); // deterministic binary gate
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    const gen = jest.fn().mockRejectedValue(new Error('timeout')) as jest.MockedFunction<ResearchGenerate>;
    expect((await relevanceGate(gen, 'anything', 'topic')).keep).toBe(true);
  });

  it('fails open (keep) on EMPTY output — a reasoning model starved by the token cap returns ""', async () => {
    const gen = genReturning(reply('', 480));
    const r = await relevanceGate(gen, 'Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(480);
  });
});
