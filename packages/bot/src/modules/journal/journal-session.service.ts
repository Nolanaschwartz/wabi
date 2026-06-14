import { Injectable } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { JsonLogger } from '../../lib/json-logger';

const PENDING_KEY_PREFIX = 'wabi:journalpending:';
/** Capture window for the conversational journal prompt. After this, a bare prompt is silently dropped. */
export const JOURNAL_PENDING_TTL_SECONDS = 10 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 5000;

/**
 * Pending-journal state for the two-turn conversational capture: a bare "i want to journal" sets a
 * marker, and the person's NEXT DM is taken as the entry. Lives in Redis with a TTL (persistence OFF,
 * ADR-0009) — ephemeral conversational state, never durable transcript content (only a boolean marker
 * is stored; the entry text never lands here).
 *
 * Mirrors the tilt pending-offer state machine in shape (set / consume / clear), but the consume is an
 * atomic getDel so a capture and a TTL expiry can't race into a double-write. Every read fails soft to
 * "not pending" so a degraded Redis can never block the safety/coaching path.
 */
@Injectable()
export class JournalSessionService {
  private readonly logger = new JsonLogger(JournalSessionService.name);
  private client: RedisClientType;
  private initialized = false;

  constructor(redisUrl?: string) {
    this.client = createClient({
      url: redisUrl || process.env.REDIS_URL || 'redis://localhost:6379',
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.client.on('error', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.connect().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Arm the capture: the next DM from this user becomes their journal entry (until TTL). */
  async setPending(userId: string): Promise<void> {
    try {
      await this.client.set(this.key(userId), '1', { EX: JOURNAL_PENDING_TTL_SECONDS });
    } catch (err) {
      this.logger.warn(`setPending failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Non-consuming read — used at session fetch to decide whether to skip the intent-router LLM call. */
  async isPending(userId: string): Promise<boolean> {
    try {
      return (await this.client.get(this.key(userId))) === '1';
    } catch {
      return false;
    }
  }

  /** Atomically read-and-clear the marker. Returns whether a pending capture was actually claimed. */
  async consume(userId: string): Promise<boolean> {
    try {
      return (await this.client.getDel(this.key(userId))) === '1';
    } catch {
      return false;
    }
  }

  /** Drop the marker unconditionally (crisis on the capture turn, or an abandoned prompt). */
  async clear(userId: string): Promise<void> {
    try {
      await this.client.del(this.key(userId));
    } catch {
      // best-effort; a lingering marker just expires on its own TTL.
    }
  }

  private key(userId: string): string {
    return `${PENDING_KEY_PREFIX}${userId}`;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
