import { Candidate } from './types';

export interface BotClientDeps { baseUrl: string; secret: string; fetchFn?: typeof fetch }
export type SubmitOutcome = 'submitted' | 'deduped' | 'error';

/** The worker's only coupling to the bot. All store access is the bot's; this just calls its
 * authenticated endpoints (ADR-0002/0033). */
export class BotClient {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly deps: BotClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-admin-secret': this.deps.secret };
  }

  async seen(sourceId: string): Promise<boolean> {
    const url = `${this.deps.baseUrl}/admin/strategies/seen?sourceId=${encodeURIComponent(sourceId)}`;
    try {
      const res = await this.fetchFn(url, { headers: this.headers() });
      if (!res.ok) return false;
      const body = (await res.json()) as { seen?: boolean };
      return body.seen === true;
    } catch {
      return false;
    }
  }

  async submit(candidate: Candidate): Promise<SubmitOutcome> {
    const url = `${this.deps.baseUrl}/admin/strategies/ingest`;
    try {
      const res = await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(candidate) });
      if (res.status === 201 || res.ok) return 'submitted';
      if (res.status === 409) return 'deduped';
      return 'error';
    } catch {
      return 'error';
    }
  }
}
