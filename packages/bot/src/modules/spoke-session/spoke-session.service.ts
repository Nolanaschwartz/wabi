import { Injectable } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { JsonLogger } from '../../lib/json-logger';

/** The hub's spokes. `coach` is the hub's own fallback, not a spoke, so it never arms the floor. */
export type Spoke = 'journal' | 'tilt' | 'mood';

const SPOKE_SESSION_KEY_PREFIX = 'wabi:spokesession:';
/** Floor window for a spoke's follow-up turn. After this, an unclaimed floor is silently dropped. */
export const SPOKE_SESSION_TTL_SECONDS = 10 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 5000;

/**
 * Spoke-keyed conversational floor for the hub-and-spoke router. A spoke that expects the person's NEXT
 * DM (e.g. journal after a prompt) arms the floor with its own name; the hub then routes that next turn
 * straight back to the spoke without re-running the discovery LLM. This is the deterministic half of the
 * discovery-vs-flow split — the LLM picks a spoke only on a fresh turn; continuity is a state machine.
 *
 * Generalises the journal-only pending-capture marker. Lives in Redis with a TTL (persistence OFF,
 * ADR-0009) — ephemeral conversational state, never durable transcript content (only the spoke NAME is
 * stored; entry text never lands here, ADR-0013). consume is an atomic getDel so a claim and a TTL
 * expiry can't race into a double-write. Every read fails soft to "no active spoke" so a degraded Redis
 * can never block the safety/coaching path.
 */
@Injectable()
export class SpokeSessionService {
  private readonly logger = new JsonLogger(SpokeSessionService.name);
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

  /** Arm the floor: the next DM from this user is routed back to `spoke` (until TTL). */
  async setActive(userId: string, spoke: Spoke): Promise<void> {
    try {
      await this.client.set(this.key(userId), spoke, { EX: SPOKE_SESSION_TTL_SECONDS });
    } catch (err) {
      this.logger.warn(`setActive failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Non-consuming read — used by the hub to decide whether to skip the discovery LLM call. */
  async active(userId: string): Promise<Spoke | null> {
    try {
      return ((await this.client.get(this.key(userId))) as Spoke | null) ?? null;
    } catch {
      return null;
    }
  }

  /** Atomically read-and-clear the floor. Returns the spoke that held it, or null if it was clear. */
  async consume(userId: string): Promise<Spoke | null> {
    try {
      return ((await this.client.getDel(this.key(userId))) as Spoke | null) ?? null;
    } catch {
      return null;
    }
  }

  /** Drop the floor unconditionally (crisis on the floor turn, or an abandoned prompt). */
  async clear(userId: string): Promise<void> {
    try {
      await this.client.del(this.key(userId));
    } catch {
      // best-effort; a lingering marker just expires on its own TTL.
    }
  }

  private key(userId: string): string {
    return `${SPOKE_SESSION_KEY_PREFIX}${userId}`;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
