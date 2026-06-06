import { splitMessage } from '../message-splitter';

describe('splitMessage', () => {
  it('returns single part for short message', () => {
    const result = splitMessage('hello world');
    expect(result).toEqual(['hello world']);
  });

  it('splits on newline for long message', () => {
    const msg = 'this is a longer line of text\n'.repeat(200) + 'end';
    const result = splitMessage(msg);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((p) => p.length <= 2000)).toBe(true);
  });

  it('splits on space when no newline', () => {
    const msg = 'thisword '.repeat(800);
    const result = splitMessage(msg);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((p) => p.length <= 2000)).toBe(true);
  });

  it('hard splits at limit when no split point', () => {
    const msg = 'a'.repeat(3000);
    const result = splitMessage(msg);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(2000);
    expect(result[1].length).toBe(1000);
  });

  it('respects custom max length', () => {
    const msg = 'hello world foo bar';
    const result = splitMessage(msg, 5);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((p) => p.length <= 5)).toBe(true);
  });
});
