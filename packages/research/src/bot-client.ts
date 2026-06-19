import { Candidate } from './types';

export interface BotClientDeps { baseUrl: string; secret: string; fetchFn?: typeof fetch }
export type SubmitOutcome = 'submitted' | 'deduped' | 'rejected' | 'error';

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

  /** Negative-cache a relevance-gate rejection in the bot's ledger so seen() skips this paper next
   * run instead of re-gating it every cycle. Fail-open: a transport error just means it re-gates. */
  async markGated(sourceId: string, source: string): Promise<void> {
    const url = `${this.deps.baseUrl}/admin/strategies/gated`;
    try {
      await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ sourceId, source }) });
    } catch {
      // swallow — re-gating next run is the harmless worst case
    }
  }

  /** Submit all drafts mined from ONE paper in a single call. The bot evaluates each independently
   * and marks the per-source ledger once; the response carries a per-draft outcome we map in order.
   * Any transport failure fails the whole batch closed to 'error' (the run can retry the paper). */
  async submitBatch(candidates: Candidate[]): Promise<SubmitOutcome[]> {
    const url = `${this.deps.baseUrl}/admin/strategies/ingest/batch`;
    try {
      const res = await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ candidates }) });
      if (!res.ok) return candidates.map(() => 'error');
      const body = (await res.json().catch(() => ({}))) as { results?: { status?: string }[] };
      if (!Array.isArray(body.results)) return candidates.map(() => 'error');
      return body.results.map((r) =>
        r.status === 'submitted' || r.status === 'deduped' || r.status === 'rejected' ? r.status : 'error',
      );
    } catch {
      return candidates.map(() => 'error');
    }
  }
}
