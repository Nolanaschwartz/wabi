import { Injectable } from '@nestjs/common';
import { MemoryStoreService } from './memory-store.service';
import { UserService } from '../user/user.service';
import { JsonLogger } from '../../lib/json-logger';

/**
 * Feeds a person's free-text inner state (journal / mood note / tilt trigger) into derived Memory —
 * but only when they have opted in (ADR-0029). Callers know nothing about consent, Mem0, or
 * namespaces: they hand over already-screened free text and this decides whether it becomes Memory.
 *
 * Depth lives in *where it is called*: every caller invokes it inside the Crisis Screening `guard()`
 * success closure (ADR-0028), so crisis-tripping text physically cannot reach it. The method itself
 * stays trivial and fails soft — a degraded consent lookup or a degraded Mem0 must never break the
 * write that logged the entry.
 */
@Injectable()
export class InnerStateMemoryService {
  private readonly logger = new JsonLogger(InnerStateMemoryService.name);

  constructor(
    private readonly memoryStore: MemoryStoreService,
    private readonly userService: UserService,
  ) {}

  async deriveIfConsented(userId: string, text: string): Promise<void> {
    try {
      const user = await this.userService.findByDiscordId(userId, { innerStateMemoryEnabled: true });

      if (!user?.innerStateMemoryEnabled) return;

      await this.memoryStore.deriveAndStore(userId, text);
    } catch (err) {
      // Fail soft: inner-state derivation is best-effort. Logging a private note must never throw
      // back into the write path and fail the log itself.
      this.logger.debug('inner-state derive skipped (degraded)', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
