import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';

const TILT_DURATION_MINUTES = 30;
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
  constructor(
    private readonly strategyRetrieval: StrategyRetrievalService,
  ) {}

  isTiltLanguage(text: string): boolean {
    const lower = text.toLowerCase();
    return TILT_KEYWORDS.some((keyword) => lower.includes(keyword));
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
