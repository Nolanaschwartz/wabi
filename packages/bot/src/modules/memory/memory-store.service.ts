import { Injectable } from '@nestjs/common';
export type MemoryEntry = {
  id: string;
  content: string;
};

@Injectable()
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
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: sessionText }],
          user_id: `mem0_${userId}`,
        }),
      });
      if (!res.ok) {
        console.error(`[memory] add failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error('[memory] add error', err);
    }
  }

  async search(
    userId: string,
    query: string,
  ): Promise<MemoryEntry[]> {
    if (!this.enabled) return [];

    try {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          user_id: `mem0_${userId}`,
        }),
      });
      if (!res.ok) {
        console.error(
          `[memory] search failed: ${res.status} ${await res.text()}`,
        );
        return [];
      }
      const json = await res.json();
      return (json.results ?? []).map((r: any) => ({
        id: r.id,
        content: r.memory ?? '',
      }));
    } catch (err) {
      console.error('[memory] search error', err);
      return [];
    }
  }

  async getAllForUser(userId: string): Promise<MemoryEntry[]> {
    if (!this.enabled) return [];

    try {
      const res = await fetch(
        `${this.baseUrl}/memories?user_id=${encodeURIComponent(`mem0_${userId}`)}`,
      );
      if (!res.ok) {
        console.error(
          `[memory] getAll failed: ${res.status} ${await res.text()}`,
        );
        return [];
      }
      const json = await res.json();
      return (json.results ?? []).map((r: any) => ({
        id: r.id,
        content: r.memory ?? '',
      }));
    } catch (err) {
      console.error('[memory] getAll error', err);
      return [];
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const res = await fetch(
        `${this.baseUrl}/memories?user_id=${encodeURIComponent(`mem0_${userId}`)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        console.error(
          `[memory] delete failed: ${res.status} ${await res.text()}`,
        );
      }
    } catch (err) {
      console.error('[memory] delete error', err);
    }
  }
}
