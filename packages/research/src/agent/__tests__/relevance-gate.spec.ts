// relevanceGate is now a caller of the injected `genObj` seam (schema-decoded, not text-parsed): build
// prompt -> genObj('gate', 'research-triage', { prompt, schema: GateSchema, temperature: 0 }) -> map
// result. The MECHANISM (role→cap binding, provider resolution, the call, span emission) lives in
// `genObj`; what stays here and is tested is the gate's DOMAIN logic — the keep field, topic/scope
// wording, role/span, and its fail-OPEN policy (error/object-absent -> keep).
import { relevanceGate } from '../relevance-gate';
import { SCOPE_FRAGMENT } from '../scope-policy';
import type { ResearchGenerateObject } from '../research-generate';

describe('relevanceGate', () => {
  // A fake `genObj`: returns a canned {object, tokens} result, recording how the gate called it.
  const genObjReturning = <T>(object: T | undefined, tokens: number): jest.MockedFunction<ResearchGenerateObject> =>
    jest.fn().mockResolvedValue({ object, tokens }) as jest.MockedFunction<ResearchGenerateObject>;

  it('keeps an on-topic abstract when genObj returns keep: true', async () => {
    const genObj = genObjReturning({ keep: true }, 5);
    const r = await relevanceGate(genObj, 'Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract when genObj returns keep: false', async () => {
    const genObj = genObjReturning({ keep: false }, 4);
    expect((await relevanceGate(genObj, 'A study of knee cartilage repair.', 'tilt')).keep).toBe(false);
  });

  it('keeps a transferable-mechanism abstract for the topic', async () => {
    const genObj = genObjReturning({ keep: true }, 5);
    expect((await relevanceGate(genObj, 'Implementation intentions improved habit follow-through.', 'motivation')).keep).toBe(true);
  });

  it('drops a supplement/clinical abstract when model returns keep: false', async () => {
    const genObj = genObjReturning({ keep: false }, 4);
    expect((await relevanceGate(genObj, 'Vitamin D supplementation improved mood.', 'mood')).keep).toBe(false);
  });

  it('prompts with the run topic and the shared scope fragment', async () => {
    const genObj = genObjReturning({ keep: true }, 5);
    await relevanceGate(genObj, 'abstract body', 'rumination');
    const prompt: string = genObj.mock.calls[0][2].prompt;
    expect(prompt).toContain('rumination');
    expect(prompt).toContain(SCOPE_FRAGMENT);
  });

  it('calls genObj with span "gate", role "research-triage", schema, and is deterministic (temp 0)', async () => {
    const genObj = genObjReturning({ keep: true }, 5);
    await relevanceGate(genObj, 'x', 'topic');
    expect(genObj.mock.calls[0][0]).toBe('gate');
    expect(genObj.mock.calls[0][1]).toBe('research-triage');
    expect(genObj.mock.calls[0][2].temperature).toBe(0); // deterministic binary gate
    expect(genObj.mock.calls[0][2].schema).toBeDefined();
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    const genObj = jest.fn().mockRejectedValue(new Error('timeout')) as jest.MockedFunction<ResearchGenerateObject>;
    expect((await relevanceGate(genObj, 'anything', 'topic')).keep).toBe(true);
  });

  it('fails open (keep, tokens counted) when genObj returns object undefined (schema/soft failure)', async () => {
    // An object-absent reply — e.g. a reasoning model whose schema validation failed — must NOT be
    // read as a rejection: the fail-open default is keep, same as a transport error (ADR-0021).
    const genObj = genObjReturning(undefined, 480);
    const r = await relevanceGate(genObj, 'Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(480); // tokens from the successful call are still counted
  });
});
