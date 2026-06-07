import { Injectable } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { prisma } from '@wabi/shared';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';

const TILT_DURATION_MINUTES = 30;
const OFFER_TTL_MS = 5 * 60 * 1000;
const AUTO_RESOLVE_QUEUE = 'tilt-auto-resolve';
const AUTO_RESOLVE_CRON = '*/5 * * * *';
const OFFER_DEFAULT_SEVERITY = 5;
const TILT_KEYWORDS = [
  'tilt',
  'frustrated',
  'pissed',
  'raging',
  'feeding',
  'trolling',
  'toxic',
  'annoying',
  'stupid teammates',
  'bad game',
  'lose streak',
];

export interface TiltSession {
  trigger: string;
  severity: number;
  technique?: string;
}

export interface TiltOffer {
  acceptMessage: string;
  declineMessage: string;
  trigger: string;
}

@Injectable()
export class TiltService {
  private bossClient: PgBoss | null = null;
  // Ephemeral accept/decline window for a detection-driven offer. Losing this on
  // restart is acceptable — the offer simply lapses and the user can re-trigger.
  private pendingOffers = new Map<string, { trigger: string; expiresAt: number }>();

  constructor(
    private readonly strategyRetrieval: StrategyRetrievalService,
  ) {}

  async init(): Promise<void> {
    if (!process.env.DATABASE_URL) return;

    try {
      this.bossClient = new PgBoss({
        connectionString: process.env.DATABASE_URL,
      });
      await this.bossClient.start();
      await this.bossClient.createQueue(AUTO_RESOLVE_QUEUE);
      await this.bossClient.schedule(AUTO_RESOLVE_QUEUE, AUTO_RESOLVE_CRON);
      await this.bossClient.work(AUTO_RESOLVE_QUEUE, async () => {
        await this.autoResolveExpired();
      });
    } catch {
      // Graceful degradation
    }
  }

  async destroy(): Promise<void> {
    if (this.bossClient) {
      await this.bossClient.stop();
    }
  }

  isTiltLanguage(text: string): boolean {
    const lower = text.toLowerCase();
    return TILT_KEYWORDS.some((keyword) => lower.includes(keyword));
  }

  /** The first tilt keyword present in the text, used as the offer's trigger. */
  detectTrigger(text: string): string | null {
    const lower = text.toLowerCase();
    return TILT_KEYWORDS.find((keyword) => lower.includes(keyword)) ?? null;
  }

  setPendingOffer(discordId: string, trigger: string): void {
    this.pendingOffers.set(discordId, {
      trigger,
      expiresAt: Date.now() + OFFER_TTL_MS,
    });
  }

  getPendingOffer(discordId: string): string | null {
    const offer = this.pendingOffers.get(discordId);
    if (!offer) return null;
    if (offer.expiresAt < Date.now()) {
      this.pendingOffers.delete(discordId);
      return null;
    }
    return offer.trigger;
  }

  clearPendingOffer(discordId: string): void {
    this.pendingOffers.delete(discordId);
  }

  /**
   * Accept a detection-driven offer: starts a Tilt Session for the stored trigger
   * at a default mid severity (the offer path doesn't ask the user for 1–10) and
   * clears the pending offer. Returns the reset technique, or null if no offer.
   */
  async acceptPendingOffer(discordId: string): Promise<string | null> {
    const trigger = this.getPendingOffer(discordId);
    if (!trigger) return null;
    this.clearPendingOffer(discordId);
    return this.acceptOffer(discordId, {
      trigger,
      severity: OFFER_DEFAULT_SEVERITY,
    });
  }

  createOffer(trigger: string): TiltOffer {
    return {
      acceptMessage: `I noticed you're dealing with "${trigger}". Want to start a tilt session to reset? Reply **accept** or **decline**.`,
      declineMessage: "No problem — focus on the next round. I'm here if you need me.",
      trigger,
    };
  }

  async acceptOffer(
    discordId: string,
    tilt: TiltSession,
  ): Promise<string> {
    const strategy = await this.getResetTechnique(tilt.trigger);

    await prisma.tiltSession.create({
      data: {
        userId: discordId,
        trigger: tilt.trigger,
        severity: tilt.severity,
        technique: strategy ?? null,
        expiresAt: new Date(Date.now() + TILT_DURATION_MINUTES * 60 * 1000),
      },
    });

    return strategy ?? "Take a deep breath and step away for a bit.";
  }

  async start(
    discordId: string,
    tilt: TiltSession,
  ): Promise<string> {
    return this.acceptOffer(discordId, tilt);
  }

  async resolve(discordId: string): Promise<void> {
    await prisma.tiltSession.updateMany({
      where: {
        userId: discordId,
        resolved: false,
      },
      data: {
        resolved: true,
      },
    });
  }

  async autoResolveExpired(): Promise<number> {
    const result = await prisma.tiltSession.updateMany({
      where: {
        resolved: false,
        expiresAt: { lt: new Date() },
      },
      data: {
        resolved: true,
      },
    });

    return result.count;
  }

  async stats(discordId: string): Promise<{
    total: number;
    avgSeverity: number;
    commonTriggers: Array<{ trigger: string; count: number }>;
  }> {
    const sessions = await prisma.tiltSession.findMany({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
    });

    const total = sessions.length;
    const avgSeverity = total > 0
      ? Math.round((sessions.reduce((acc, s) => acc + s.severity, 0) / total) * 10) / 10
      : 0;

    const triggerCounts = sessions.reduce<Record<string, number>>((acc, s) => {
      acc[s.trigger] = (acc[s.trigger] ?? 0) + 1;
      return acc;
    }, {});

    const commonTriggers = Object.entries(triggerCounts)
      .map(([trigger, count]) => ({ trigger, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return { total, avgSeverity, commonTriggers };
  }

  private async getResetTechnique(trigger: string): Promise<string> {
    const strategies = await this.strategyRetrieval.search(`reset technique for ${trigger}`);

    if (strategies.length > 0) {
      return strategies[0].content;
    }

    return "Try the 4-7-8 breathing technique: inhale for 4, hold for 7, exhale for 8.";
  }
}
