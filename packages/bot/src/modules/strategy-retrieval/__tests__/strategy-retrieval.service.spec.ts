import { StrategyRetrievalService } from '../strategy-retrieval.service';
import { getProvider } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(),
}));

jest.mock('@qdrant/qdrant-js', () => {
  return {
    QdrantClient: jest.fn().mockImplementation(() => ({
      getCollections: jest.fn().mockResolvedValue({ collections: [] }),
      createCollection: jest.fn().mockResolvedValue(true),
      search: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(true),
    })),
  };
});

describe('StrategyRetrievalService', () => {
  let service: StrategyRetrievalService;

  beforeEach(() => {
    (getProvider as jest.Mock).mockReturnValue({
      baseUrl: 'http://localhost:8081',
      model: 'nomic-embed-text',
      apiKey: '',
    });
    service = new StrategyRetrievalService();
  });

  it('initializes without error', async () => {
    await expect(service.init()).resolves.not.toThrow();
  });

  it('returns empty array when no points', async () => {
    const results = await service.search('test query');
    expect(results).toEqual([]);
  });

  it('handles search errors gracefully', async () => {
    (service as any).qdrant.search = jest.fn().mockRejectedValue(new Error('connection refused'));
    const results = await service.search('test');
    expect(results).toEqual([]);
  });

  it('handles upsert errors gracefully', async () => {
    (service as any).qdrant.upsert = jest.fn().mockRejectedValue(new Error('connection refused'));
    await expect(
      service.upsert('1', 'test content', 'test evidence'),
    ).resolves.not.toThrow();
  });

  it('uses vector search (not scroll) for retrieval', async () => {
    const mockSearch = jest.fn().mockResolvedValue([]);
    (service as any).qdrant.search = mockSearch;
    jest.spyOn(service as any, 'embed').mockResolvedValue(new Array(768).fill(0));
    await service.search('test query');
    expect(mockSearch).toHaveBeenCalled();
  });
});
