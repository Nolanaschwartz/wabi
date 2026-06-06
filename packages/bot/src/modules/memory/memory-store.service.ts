export type MemoryEntry = {
  id: string;
  content: string;
};

export class MemoryStoreService {
  private enabled: boolean;
  private baseUrl: string | undefined;

  constructor() {
    this.baseUrl = process.env.MEM0_URL;
    this.enabled = !!this.baseUrl;
  }

  async deriveAndStore(
    userId: string,
    sessionText: string,
  ): Promise<void> {
    if (!this.enabled) return;

    try {
      await fetch(`${this.baseUrl}/v1/memories/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: sessionText }],
          user_id: `mem0_${userId}`,
        }),
      });
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
      const res = await fetch(`${this.baseUrl}/v1/memories/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          user_id: `mem0_${userId}`,
        }),
      });
      const json = await res.json();
      return (json.results ?? []).map((r) => ({
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
      await fetch(`${this.baseUrl}/v1/memories/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: `mem0_${userId}`,
        }),
      });
    } catch {
      // Best-effort deletion
    }
  }
}
