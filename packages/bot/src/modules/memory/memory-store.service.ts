import { Injectable } from '@nestjs/common';
import {
  deriveAndStore,
  search,
  getAllForUser,
  deleteAllForUser,
  type MemoryEntry,
  type MemorySearchHit,
  SEARCH_CANDIDATE_LIMIT,
} from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

// Re-export the shared types/constant so existing bot imports (`from '../memory/memory-store.service'`)
// keep resolving — the REST mechanics now live in @wabi/shared (one client for the bot + voice surfaces).
export { SEARCH_CANDIDATE_LIMIT };
export type { MemoryEntry, MemorySearchHit };

/**
 * NestJS adapter over the shared mem0 client: owns DI, the MEM0_URL/enabled gate, and the structured
 * JsonLogger observability the bot relies on. The HTTP/parse logic itself is {@link deriveAndStore} et
 * al. in @wabi/shared, shared verbatim with the voice surface so DM and voice read the same facts.
 */
@Injectable()
export class MemoryStoreService {
  private readonly logger = new JsonLogger(MemoryStoreService.name);
  private enabled: boolean;

  constructor() {
    this.enabled = !!process.env.MEM0_URL;
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

  async deriveAndStore(userId: string, sessionText: string): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('mem0 disabled, skip deriveAndStore', { userId });
      return;
    }
    try {
      const res = await deriveAndStore(userId, sessionText, (status, body) =>
        this.logOp('deriveAndStore', userId, 'http_error', { status, body }),
      );
      if (!res) return;
      this.logOp('deriveAndStore', userId, 'success', {
        createdCount: res.createdIds.length,
        ids: res.createdIds,
        events: res.events.map((e) => ({ id: e.id, event: e.event })),
      });
    } catch (err) {
      this.logOp('deriveAndStore', userId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async search(userId: string, query: string): Promise<MemorySearchHit[]> {
    if (!this.enabled) return [];
    try {
      const hits = await search(userId, query, (status, body) =>
        this.logOp('search', userId, 'http_error', { status, query, body }),
      );
      if (!hits) return [];
      this.logOp('search', userId, 'success', {
        query,
        hitCount: hits.length,
        ids: hits.map((r) => r.id),
      });
      return hits;
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
      const entries = await getAllForUser(userId, (status, body) =>
        this.logOp('getAll', userId, 'http_error', { status, body }),
      );
      if (!entries) return [];
      this.logOp('getAll', userId, 'success', {
        totalCount: entries.length,
        ids: entries.map((r) => r.id),
      });
      return entries;
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
      const ok = await deleteAllForUser(userId, (status, body) =>
        this.logOp('deleteAll', userId, 'http_error', { status, body }),
      );
      if (ok) this.logOp('deleteAll', userId, 'success', { deleted: true });
    } catch (err) {
      this.logOp('deleteAll', userId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
