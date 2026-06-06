import MemoryClient from 'mem0ai';

export type MemoryEntry = {
  id: string;
  content: string;
};

export class MemoryStoreService {
  private mem0!: MemoryClient;
  private enabled: boolean;

  constructor() {
    this.enabled = !!process.env.MEM0_API_KEY;
    if (this.enabled) {
      this.mem0 = new MemoryClient({
        apiKey: process.env.MEM0_API_KEY ?? '',
      });
    }
  }

  async deriveAndStore(
    userId: string,
    sessionText: string,
  ): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.mem0.add(
        [{ role: 'user', content: sessionText }],
        { userId: `mem0_${userId}` },
      );
    } catch {
      // Best-effort memory storage
    }
  }

  async search(
    userId: string,
    query: string,
  ): Promise<MemoryEntry[]> {
    if (!this.enabled) return [];

    try {
      const results = await this.mem0.search(query, {
        filters: { userId: `mem0_${userId}` },
      });

      return (results.results ?? []).map((r) => ({
        id: r.id,
        content: r.memory ?? '',
      }));
    } catch {
      return [];
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.mem0.deleteAll({
        userId: `mem0_${userId}`,
      });
    } catch {
      // Best-effort deletion
    }
  }
}
