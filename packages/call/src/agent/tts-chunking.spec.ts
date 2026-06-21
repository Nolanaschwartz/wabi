import { takeSentences, takeFirstChunk } from './voice-agent.service';

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

describe('takeFirstChunk', () => {
  it('takes a complete first sentence as-is when one is present', () => {
    expect(takeFirstChunk('Hi there. How are you?')).toEqual({
      chunk: 'Hi there.',
      rest: ' How are you?',
    });
  });

  it('flushes early at a clause boundary past the minimum length', () => {
    expect(takeFirstChunk('You got it, take care')).toEqual({
      chunk: 'You got it,',
      rest: ' take care',
    });
  });

  it('cuts a long opener at its earliest comma, not the far-off period', () => {
    // Regression: a complete-but-long first sentence must not synthesize whole — the early comma wins.
    expect(takeFirstChunk("I'm doing great, always here when you need me.")).toEqual({
      chunk: "I'm doing great,",
      rest: ' always here when you need me.',
    });
  });

  it('does not fragment a tiny opener whose comma is below the minimum', () => {
    expect(takeFirstChunk('Hi, there')).toEqual({ chunk: null, rest: 'Hi, there' });
  });

  it('waits on a short buffer with no boundary at all', () => {
    expect(takeFirstChunk('just one breath')).toEqual({
      chunk: null,
      rest: 'just one breath',
    });
  });

  it('cuts a long boundary-less run-on at the last word break under the cap', () => {
    const buf = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ff';
    expect(takeFirstChunk(buf)).toEqual({
      chunk: 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd',
      rest: ' eeeeeeeeee ff',
    });
  });
});
