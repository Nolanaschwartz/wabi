import { selectNeighbors } from '../discovery-selector';

const source = { title: 'Breathing and stress', abstract: 'A study of paced breathing.' };
const neighbors = [
  { id: 'PMID:1', title: 'Box breathing for anxiety' },
  { id: 'PMID:2', title: 'Knee surgery outcomes' },
  { id: 'PMID:3', title: 'Diaphragmatic breathing review' },
];

it('returns the model-chosen ids, capped to maxChase', async () => {
  const gen = jest.fn().mockResolvedValue({ text: JSON.stringify({ chase: [0, 2] }), usage: { totalTokens: 20 } });
  const out = await selectNeighbors(gen as any, 'stress', source, neighbors, 3);
  expect(out.ids).toEqual(['PMID:1', 'PMID:3']);
  expect(out.tokens).toBe(20);
});

it('caps to maxChase even if the model returns more', async () => {
  const gen = jest.fn().mockResolvedValue({ text: JSON.stringify({ chase: [0, 1, 2] }), usage: {} });
  const out = await selectNeighbors(gen as any, 'stress', source, neighbors, 2);
  expect(out.ids).toHaveLength(2);
});

it('fails open to the deterministic top-maxChase on a thrown gen', async () => {
  const gen = jest.fn().mockRejectedValue(new Error('down'));
  const out = await selectNeighbors(gen as any, 'stress', source, neighbors, 2);
  expect(out.ids).toEqual(['PMID:1', 'PMID:2']);
  expect(out.tokens).toBe(0);
});

it('fails open to top-maxChase on out-of-range / unparseable indices', async () => {
  const gen = jest.fn().mockResolvedValue({ text: 'garbage', usage: { totalTokens: 5 } });
  const out = await selectNeighbors(gen as any, 'stress', source, neighbors, 1);
  expect(out.ids).toEqual(['PMID:1']);
});
