import { Injectable } from '@nestjs/common';
const DEBOUNCE_MS = 3000;
const HOURLY_CEILING = 30;
const CEILING_MESSAGE =
  "I care about our conversations, and I want to give each one the attention it deserves. Let's take these one at a time — what's on your mind?";

/**
 * The outcome of feeding a message into the coalescer. Each variant is a distinct instruction
 * to the caller, so no outcome can masquerade as another:
 *  - `ready`        — the debounce elapsed; `text` is the batch to classify + coach.
 *  - `coalesced`    — folded into an in-flight burst; this turn produces no reply, just return.
 *  - `canceled`     — the pending turn was canceled (e.g. a crisis arrived mid-burst); drop it.
 *  - `rate_limited` — the hourly ceiling tripped; SEND `text` to the user, do NOT coach it.
 *
 * The previous stringly interface (`Promise<string> | null` with a `'__canceled__'` sentinel)
 * let the ceiling reply return as a plain string, which the caller treated as a batch and
 * re-coached — the rate limit silently did nothing. The union makes that unrepresentable.
 */
export type CoalesceResult =
  | { kind: 'ready'; text: string }
  | { kind: 'coalesced' }
  | { kind: 'canceled' }
  | { kind: 'rate_limited'; text: string };

interface CoalescedTurn {
  messages: string[];
  resolve: (result: CoalesceResult) => void;
  cancel: () => void;
  isCanceled: boolean;
}

@Injectable()
export class BurstCoalescer {
  private pending = new Map<string, CoalescedTurn>();
  private timers = new Map<string, NodeJS.Timeout>();
  private hourlyCounts = new Map<string, number>();
  private hourlyResets = new Map<string, number>();

  coalesce(userId: string, initialMessage?: string): Promise<CoalesceResult> {
    const existing = this.pending.get(userId);
    if (existing) {
      if (initialMessage) existing.messages.push(initialMessage);
      return Promise.resolve({ kind: 'coalesced' });
    }

    const hourlyLimit = this.getHourlyLimit(userId);
    if (this.isOverCeiling(userId, hourlyLimit)) {
      return Promise.resolve({ kind: 'rate_limited', text: CEILING_MESSAGE });
    }

    return new Promise<CoalesceResult>((resolve) => {
      const turn: CoalescedTurn = {
        messages: initialMessage ? [initialMessage] : [],
        resolve,
        cancel: () => {
          turn.isCanceled = true;
          const timer = this.timers.get(userId);
          if (timer) {
            clearTimeout(timer);
            this.timers.delete(userId);
          }
          this.pending.delete(userId);
          resolve({ kind: 'canceled' });
        },
        isCanceled: false,
      };

      this.pending.set(userId, turn);

      const timer = setTimeout(() => {
        if (!turn.isCanceled) {
          this.timers.delete(userId);
          const messages = [...turn.messages];
          this.pending.delete(userId);
          resolve({ kind: 'ready', text: messages.join('\n') });
        }
      }, DEBOUNCE_MS);
      this.timers.set(userId, timer);
    });
  }

  addMessage(userId: string, content: string): void {
    const turn = this.pending.get(userId);
    if (turn) {
      turn.messages.push(content);
    }
  }

  cancel(userId: string): void {
    const turn = this.pending.get(userId);
    if (turn) {
      turn.cancel();
    }
  }

  getBatch(userId: string): string[] {
    const turn = this.pending.get(userId);
    return turn?.messages ?? [];
  }

  private getHourlyLimit(userId: string): number {
    const now = Date.now();
    const resetTime = this.hourlyResets.get(userId) ?? now;
    if (now > resetTime) {
      this.hourlyCounts.set(userId, 0);
      this.hourlyResets.set(userId, now + 3600_000);
    }
    return this.hourlyCounts.get(userId) ?? 0;
  }

  private isOverCeiling(userId: string, currentCount: number): boolean {
    if (currentCount >= HOURLY_CEILING) {
      return true;
    }
    this.hourlyCounts.set(userId, currentCount + 1);
    return false;
  }

  getPendingCount(): number {
    return this.pending.size;
  }
}
