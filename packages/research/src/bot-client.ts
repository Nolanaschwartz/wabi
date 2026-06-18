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

  async submit(candidate: Candidate): Promise<SubmitOutcome> {
    const url = `${this.deps.baseUrl}/admin/strategies/ingest`;
    try {
      const res = await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(candidate) });
      if (res.status === 409) return 'deduped';
      if (!res.ok) return 'error';
      // A 201 covers BOTH a queued draft and a gate REJECTION (no draft persisted) — they are
      // distinguished only by the body's status field, so read it rather than trust the 201.
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      if (body.status === 'rejected') return 'rejected';
      if (body.status === 'deduped') return 'deduped';
      return 'submitted';
    } catch {
      return 'error';
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
