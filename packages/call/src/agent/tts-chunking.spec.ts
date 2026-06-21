import { takeSentences } from './voice-agent.service';

describe('takeSentences', () => {
  it('pulls complete sentences and leaves the trailing partial in rest', () => {
    expect(takeSentences('Hi there. How are you? Glad you came!')).toEqual({
      sentences: ['Hi there.', 'How are you?', 'Glad you came!'],
      rest: '',
    });
  });

  it('holds back text that has not hit terminal punctuation yet', () => {
    expect(takeSentences('Done. now this')).toEqual({
      sentences: ['Done.'],
      rest: ' now this',
    });
  });

  it('returns no sentences for a punctuation-less buffer', () => {
    expect(takeSentences('just one breath')).toEqual({
      sentences: [],
      rest: 'just one breath',
    });
  });

  it('collapses repeated terminal punctuation into one sentence', () => {
    expect(takeSentences('Wait... really?')).toEqual({
      sentences: ['Wait...', 'really?'],
      rest: '',
    });
  });
});
