import { splitFirstChunk, MIN_FIRST_CHARS } from './first-chunk';

describe('splitFirstChunk', () => {
  it('splits at the first sentence ender at/after the floor, with a non-empty rest', () => {
    const text =
      'First sentence that is definitely longer than the sixty character floor here. Second one.';
    expect(splitFirstChunk(text)).toEqual({
      chunk1: 'First sentence that is definitely longer than the sixty character floor here.',
      rest: 'Second one.',
    });
  });

  it('merges a short leading sentence forward until the floor is reached', () => {
    const text =
      'Sure. Here is a much longer continuation that pushes us well past the sixty char floor. Tail.';
    const out = splitFirstChunk(text);
    expect(out).not.toBeNull();
    // chunk1 skips the sub-floor "Sure." and ends at the boundary past the floor; "Tail." is the rest.
    expect(out!.chunk1.startsWith('Sure. Here')).toBe(true);
    expect(out!.chunk1.length).toBeGreaterThanOrEqual(MIN_FIRST_CHARS);
    expect(out!.rest).toBe('Tail.');
  });

  it('returns null for a run-on with no sentence punctuation', () => {
    expect(splitFirstChunk(Array(40).fill('word').join(' '))).toBeNull();
  });

  it('returns null for a single short sentence below the floor', () => {
    expect(splitFirstChunk('Hi there.')).toBeNull();
  });

  it('returns null when the only boundary is at the very end (no rest to overlap)', () => {
    expect(
      splitFirstChunk('This single sentence is quite long, definitely over the sixty char floor, but ends here.'),
    ).toBeNull();
  });

  it('is lossless: chunk1 + rest reproduce the input modulo the boundary space', () => {
    const text = 'A long enough opening line that clears the configured sixty character floor cleanly. The rest.';
    const out = splitFirstChunk(text)!;
    expect(`${out.chunk1} ${out.rest}`).toBe(text);
  });
});
