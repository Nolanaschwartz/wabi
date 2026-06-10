import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../lib/safe-fetch';
export type MemoryEntry = {
  id: string;
  content: string;
};

interface Mem0CreateResponse {
  id?: string;
  events?: Array<{ id?: string; event?: string }>;
  memories?: Array<{ id?: string }>;
}

interface Mem0SearchResponse {
  results?: Array<{ id?: string; memory?: string }>;
}

@Injectable()
export class MemoryStoreService {
  private readonly logger = new Logger(MemoryStoreService.name);
  private enabled: boolean;
  private baseUrl: string | undefined;

  constructor() {
    this.baseUrl = process.env.MEM0_URL;
    this.enabled = !!this.baseUrl;
  }

  private logOp(
    op: 'deriveAndStore' | 'search' | 'getAll' | 'deleteAll',
    userId: string,
    status: 'success' | 'error' | 'http_error',
    detail: Record<string, any> = {},
  ) {
    const entry = { op, userId, status, ...detail };
    if (status === 'error' || status === 'http_error') {
      this.logger.error('mem0 crud', entry);
    } else {
      this.logger.log('mem0 crud', entry);
    }
  }

  async deriveAndStore(
    userId: string,
    sessionText: string,
  ): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('mem0 disabled, skip deriveAndStore', { userId });
      return;
    }

    try {
      const json: Mem0CreateResponse | null = await safeFetch(
        `${this.baseUrl}/memories`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: sessionText }],
            user_id: `mem0_${userId}`,
          }),
        },
        (status, body) => {
          this.logOp('deriveAndStore', userId, 'http_error', { status, body });
        },
      );

      if (!json) return;
      const createdIds = this.extractCreatedIds(json);
      this.logOp('deriveAndStore', userId, 'success', {
        createdCount: createdIds.length,
        ids: createdIds,
        events: json.events?.map((e: any) => ({
          id: e.id,
          event: e.event,
        })),
      });
    } catch (err) {
      this.logOp('deriveAndStore', userId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async search(
    userId: string,
    query: string,
  ): Promise<MemoryEntry[]> {
    if (!this.enabled) return [];

    try {
      const json = await safeFetch<Mem0SearchResponse>(
        `${this.baseUrl}/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            user_id: `mem0_${userId}`,
          }),
        },
        (status, body) => {
          this.logOp('search', userId, 'http_error', { status, query, body });
        },
      );
      if (!json) return [];
      const results = (json.results ?? []).map((r: any) => ({
        id: r.id,
        content: r.memory ?? '',
      }));
      this.logOp('search', userId, 'success', {
        query,
        hitCount: results.length,
        ids: results.map((r: MemoryEntry) => r.id),
      });
      return results;
    } catch (err) {
      this.logOp('search', userId, 'error', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getAllForUser(userId: string): Promise<MemoryEntry[]> {
    if (!this.enabled) return [];

    try {
      const json = await safeFetch<Mem0SearchResponse>(
        `${this.baseUrl}/memories?user_id=${encodeURIComponent(`mem0_${userId}`)}`,
        undefined,
        (status, body) => {
          this.logOp('getAll', userId, 'http_error', { status, body });
        },
      );
      if (!json) return [];
      const results = (json.results ?? []).map((r: any) => ({
        id: r.id,
        content: r.memory ?? '',
      }));
      this.logOp('getAll', userId, 'success', {
        totalCount: results.length,
        ids: results.map((r: MemoryEntry) => r.id),
      });
      return results;
    } catch (err) {
      this.logOp('getAll', userId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const json = await safeFetch(
        `${this.baseUrl}/memories?user_id=${encodeURIComponent(`mem0_${userId}`)}`,
        { method: 'DELETE' },
        (status, body) => {
          this.logOp('deleteAll', userId, 'http_error', { status, body });
        },
      );
      if (!json) return;

      this.logOp('deleteAll', userId, 'success', {
        deleted: true,
      });
    } catch (err) {
      this.logOp('deleteAll', userId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Extract created memory IDs from mem0 create response.
  // Response shape varies: may have top-level id, events[].id, or memories[].id.
  private extractCreatedIds(json: Mem0CreateResponse): string[] {
    const ids: string[] = [];
    if (json.id) ids.push(json.id);
    for (const evt of json.events ?? []) {
      if (evt.id) ids.push(evt.id);
    }
    for (const m of json.memories ?? []) {
      if (m.id && !ids.includes(m.id)) ids.push(m.id);
    }
    return ids;
  }
}
