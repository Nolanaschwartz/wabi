// topicToConcepts is a caller of @wabi/shared/generate: build prompt -> generate -> parse JSON, with a
// fail-open fallback to the raw content terms. The MECHANISM (provider, client) lives in generate; what
// is tested here is the parse + the fallback contract.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { topicToConcepts, topicTerms } from '../query/concepts';

describe('concepts', () => {
  const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  describe('topicTerms (fallback tokenizer)', () => {
    it('keeps distinct content words ≥3 chars and drops grammar words', () => {
      expect(topicTerms('rumination after loss cognitive reappraisal')).toEqual([
        'rumination', 'loss', 'cognitive', 'reappraisal',
      ]);
    });
    it('dedupes repeats', () => {
      expect(topicTerms('sleep sleep hygiene')).toEqual(['sleep', 'hygiene']);
    });
  });

  describe('topicToConcepts', () => {
    it('parses the model\'s core + context vocabulary', async () => {
      generate.mockResolvedValue({
        text: '{"core":["emotion regulation","cognitive reappraisal"],"context":["video gaming"]}',
      });
      const c = await topicToConcepts('tilt emotion regulation competitive gaming');
      expect(c.core).toEqual(['emotion regulation', 'cognitive reappraisal']);
      expect(c.context).toEqual(['video gaming']);
    });

    it('tolerates a fenced code block around the JSON', async () => {
      generate.mockResolvedValue({ text: '```json\n{"core":["reappraisal"],"context":[]}\n```' });
      const c = await topicToConcepts('x');
      expect(c.core).toEqual(['reappraisal']);
      expect(c.context).toEqual([]);
    });

    it('falls back to content terms (no context) when the model errors', async () => {
      generate.mockRejectedValue(new Error('timeout'));
      const c = await topicToConcepts('sleep hygiene late-night gaming');
      expect(c.core).toEqual(['sleep', 'hygiene', 'late', 'night', 'gaming']);
      expect(c.context).toEqual([]);
    });

    it('falls back when the model returns empty / unparseable / no core', async () => {
      generate.mockResolvedValue({ text: '' });
      expect((await topicToConcepts('rumination reappraisal')).core).toEqual(['rumination', 'reappraisal']);
      generate.mockResolvedValue({ text: '{"core":[],"context":["x"]}' });
      expect((await topicToConcepts('rumination reappraisal')).core).toEqual(['rumination', 'reappraisal']);
    });
  });
});
