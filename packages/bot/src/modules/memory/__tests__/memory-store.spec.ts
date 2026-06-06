import { MemoryStoreService } from '../memory-store.service';

describe('MemoryStoreService', () => {
  let store: MemoryStoreService;

  beforeEach(() => {
    store = new MemoryStoreService();
  });

  it('is disabled when MEM0_URL is not set', () => {
    expect((store as any).enabled).toBe(false);
  });

  it('does not store when disabled', async () => {
    await store.deriveAndStore('123', 'test session');
    // Should not throw
  });

  it('returns empty array when disabled', async () => {
    const results = await store.search('123', 'test query');
    expect(results).toEqual([]);
  });

  it('does not delete when disabled', async () => {
    await store.deleteAllForUser('123');
    // Should not throw
  });
});
