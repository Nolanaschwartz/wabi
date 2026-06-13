import {
  rankByRecency,
  RECENCY_WEIGHT,
  type RankableMemory,
} from '../memory-ranker';

// The ranker is a pure function: given mem0 candidates (each carrying a similarity score and an
// optional recency timestamp) plus a fixed `now`, it returns them re-ordered by a relevance-dominant
// additive recency boost. No I/O, no clock — `now` is injected so every case is deterministic.

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

const mem = (
  content: string,
  similarity: number,
  ageDays?: number,
): RankableMemory => ({
  content,
  similarity,
  updatedAt: ageDays === undefined ? undefined : NOW - ageDays * DAY,
});

const order = (ranked: RankableMemory[]) => ranked.map((m) => m.content);

describe('rankByRecency', () => {
  it('breaks ties between equal-similarity facts by recency (newer first)', () => {
    const ranked = rankByRecency(
      [mem('older', 0.8, 30), mem('newer', 0.8, 1)],
      NOW,
    );

    expect(order(ranked)).toEqual(['newer', 'older']);
  });

  it('keeps relevance dominant: a clearly higher-similarity old fact beats a low-similarity recent one', () => {
    // The recency term can shift a score by at most RECENCY_WEIGHT, so a similarity gap wider than
    // that can never be overturned by recency — recency is a bias, not an override.
    const similarityGap = RECENCY_WEIGHT + 0.2;
    const ranked = rankByRecency(
      [
        mem('relevant-but-old', 0.5 + similarityGap, 120),
        mem('fresh-but-off-topic', 0.5, 0),
      ],
      NOW,
    );

    expect(order(ranked)).toEqual(['relevant-but-old', 'fresh-but-off-topic']);
  });

  it('ranks a candidate with no timestamp on similarity alone, never burying a more-relevant fact', () => {
    // A graph-derived hit may arrive without a timestamp. It must not sink below a clearly less
    // relevant (but recent) fact just because it lacks a date.
    const ranked = rankByRecency(
      [
        mem('low-sim recent', 0.5, 0),
        mem('high-sim no-date', 0.5 + RECENCY_WEIGHT + 0.2 /* gap > max boost */),
      ],
      NOW,
    );

    expect(order(ranked)).toEqual(['high-sim no-date', 'low-sim recent']);
  });

  it('decays recency monotonically with age (equal similarity → newest to oldest)', () => {
    const ranked = rankByRecency(
      [mem('oldest', 0.7, 90), mem('newest', 0.7, 1), mem('middle', 0.7, 30)],
      NOW,
    );

    expect(order(ranked)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('preserves extra fields on the candidates it re-orders', () => {
    const ranked = rankByRecency(
      [
        { id: 'a', content: 'a', similarity: 0.6, updatedAt: NOW - 40 * DAY },
        { id: 'b', content: 'b', similarity: 0.6, updatedAt: NOW - 1 * DAY },
      ],
      NOW,
    );

    expect(ranked.map((m) => (m as any).id)).toEqual(['b', 'a']);
  });

  it('returns an empty list unchanged', () => {
    expect(rankByRecency([], NOW)).toEqual([]);
  });
});
