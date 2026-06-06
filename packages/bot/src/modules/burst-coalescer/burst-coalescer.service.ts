const DEBOUNCE_MS = 3000;
const HOURLY_CEILING = 30;

interface CoalescedTurn {
  messages: string[];
  resolve: (reply: string) => void;
  cancel: () => void;
  isCanceled: boolean;
}

export class BurstCoalescer {
  private pending = new Map<string, CoalescedTurn>();
  private timers = new Map<string, NodeJS.Timeout>();
  private hourlyCounts = new Map<string, number>();
  private hourlyResets = new Map<string, number>();

  coalesce(userId: string, initialMessage?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const existing = this.pending.get(userId);
      if (existing) {
        if (initialMessage) existing.messages.push(initialMessage);
        return;
      }

      const hourlyLimit = this.getHourlyLimit(userId);
      if (this.isOverCeiling(userId, hourlyLimit)) {
        resolve(
          "I care about our conversations, and I want to give each one the attention it deserves. Let's take these one at a time — what's on your mind?",
        );
        return;
      }

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
          resolve('__canceled__');
        },
        isCanceled: false,
      };

      this.pending.set(userId, turn);

      const timer = setTimeout(() => {
        if (!turn.isCanceled) {
          this.timers.delete(userId);
          const messages = [...turn.messages];
          this.pending.delete(userId);
          resolve(messages.join('\n'));
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
