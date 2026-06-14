import { compactUsage } from '../usage';

describe('compactUsage', () => {
  it('maps both token counts to the caller-chosen keys', () => {
    expect(compactUsage({ inputTokens: 12, outputTokens: 34 }, { input: 'input', output: 'output' })).toEqual({
      input: 12,
      output: 34,
    });
  });

  it('keeps a real zero count (absent != zero)', () => {
    expect(compactUsage({ inputTokens: 0, outputTokens: 5 }, { input: 'input', output: 'output' })).toEqual({
      input: 0,
      output: 5,
    });
  });

  it('drops a field the provider omitted', () => {
    expect(compactUsage({ outputTokens: 7 }, { input: 'input', output: 'output' })).toEqual({ output: 7 });
  });

  it('returns undefined when no counts are present', () => {
    expect(compactUsage({}, { input: 'input', output: 'output' })).toBeUndefined();
    expect(compactUsage(undefined, { input: 'input', output: 'output' })).toBeUndefined();
  });

  it('honors the CoachGeneration key map too', () => {
    expect(compactUsage({ inputTokens: 1, outputTokens: 2 }, { input: 'inputTokens', output: 'outputTokens' })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });
});
