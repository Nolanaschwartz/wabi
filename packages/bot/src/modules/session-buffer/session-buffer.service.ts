import { createClient, RedisClientType } from 'redis';

const SESSION_KEY_PREFIX = 'wabi:sess:';
const SESSION_TTL_SECONDS = 30 * 60;
const MAX_TURNS = 10;

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
    this.client.on('error', () => {});
    await this.client.connect();
    this.initialized = true;
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
    await this.client.expire(key, SESSION_TTL_SECONDS);
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
    await this.client.set(`wabi:quarantine:${userId}`, 'true', { EX: 86400 });
  }

  private sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}${userId}`;
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
