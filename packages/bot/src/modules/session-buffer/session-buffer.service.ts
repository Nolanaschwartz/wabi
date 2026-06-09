import { Injectable } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

const SESSION_KEY_PREFIX = 'wabi:sess:';
const QUARANTINE_KEY_PREFIX = 'wabi:quarantine:';
const QUARANTINE_TTL_SECONDS = 24 * 60 * 60;
const SESSION_TTL_SECONDS = 30 * 60;
const MAX_TURNS = 10;
// Cap the startup Redis connect so a down/slow Redis can't block bootstrap — and the Discord
// gateway login that runs after all module init hooks. node-redis keeps retrying in the
// background and recovers when Redis returns; session features degrade until then.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

export interface SessionContext {
  sessionId: string;
  turns: Array<{ role: string; content: string }>;
  lastSeen: Date;
  doNotMine: boolean;
}

interface RawSessionData {
  sessionId?: string;
  turns?: string;
  lastSeen?: string;
  doNotMine?: string;
}

@Injectable()
export class SessionBufferService {
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
    // A dropped/failed Redis connection must never crash the bot.
    this.client.on('error', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Swallow connect rejection here so a failed initial connect degrades rather than throws.
        this.client.connect().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async append(userId: string, role: string, content: string): Promise<void> {
    const key = this.sessionKey(userId);
    const existing = await this.getRaw(userId);
    const turns = existing?.turns ? JSON.parse(existing.turns) : [];
    turns.push({ role, content });

    while (turns.length > MAX_TURNS) {
      turns.shift();
    }

    const data: Record<string, string> = {
      sessionId: existing?.sessionId ?? crypto.randomUUID(),
      turns: JSON.stringify(turns),
      lastSeen: new Date().toISOString(),
      doNotMine: existing?.doNotMine ?? 'false',
    };

    await this.client.hSet(key, data);
  }

  async getContext(userId: string): Promise<SessionContext | null> {
    const raw = await this.getRaw(userId);
    if (!raw) return null;

    const turns = raw.turns ? JSON.parse(raw.turns) : [];
    return {
      sessionId: raw.sessionId ?? crypto.randomUUID(),
      turns,
      lastSeen: raw.lastSeen ? new Date(raw.lastSeen) : new Date(),
      doNotMine: raw.doNotMine === 'true',
    };
  }

  async endSession(userId: string): Promise<void> {
    await this.client.del(this.sessionKey(userId));
  }

  async clear(userId: string): Promise<void> {
    await this.endSession(userId);
  }

  async clearAndQuarantine(userId: string): Promise<void> {
    await this.client.del(this.sessionKey(userId));
    await this.client.set(this.quarantineKey(userId), 'true', {
      EX: QUARANTINE_TTL_SECONDS,
    });
  }

  // The raw fact: is the post-crisis quarantine key still set? The *policy* of when that counts
  // (e.g. a fresh session cancelling the window) lives in CrisisAftermath, not here — this module
  // owns the key, its name, and its TTL, nothing more. Symmetric read for the clearAndQuarantine
  // write above; callers never touch the Redis client directly.
  async inAftermathWindow(userId: string): Promise<boolean> {
    const value = await this.client.get(this.quarantineKey(userId));
    return value === 'true';
  }

  private sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}${userId}`;
  }

  private quarantineKey(userId: string): string {
    return `${QUARANTINE_KEY_PREFIX}${userId}`;
  }

  private async getRaw(userId: string): Promise<RawSessionData | null> {
    const data = await this.client.hGetAll(this.sessionKey(userId));
    if (!data || Object.keys(data).length === 0) return null;
    return {
      sessionId: data.sessionId,
      turns: data.turns,
      lastSeen: data.lastSeen,
      doNotMine: data.doNotMine,
    };
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
