import { splitForTts } from './voice-agent.service';

describe('splitForTts', () => {
  it('splits a multi-sentence reply on . ! ?', () => {
    expect(splitForTts('Hi there. How are you? Glad you came!')).toEqual([
      'Hi there.',
      'How are you?',
      'Glad you came!',
    ]);
  });

  it('keeps a punctuation-less reply as a single chunk', () => {
    expect(splitForTts('just one breath')).toEqual(['just one breath']);
  });

  it('keeps trailing text with no terminal punctuation', () => {
    expect(splitForTts('Done. now this')).toEqual(['Done.', 'now this']);
  });

  it('drops whitespace-only input to nothing', () => {
    expect(splitForTts('   ')).toEqual([]);
  });
});
