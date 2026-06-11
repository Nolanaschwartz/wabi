import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';

const MOOD_EMOJIS: Record<number, string> = {
  1: '😞',
  2: '😔',
  3: '😐',
  4: '🙂',
  5: '😊',
};

export interface MoodLog {
  rating: number;
  emoji: string;
  note?: string;
  context?: string;
}

@Injectable()
export class MoodService {
  // Plain persist: writes the mood record. Crisis screening of the free-text `note` and the
  // consent-gated derivation of it are owned by InnerStateLogger now (ADR-0028/0029); a mood is only
  // ever written from inside that logger's safe-path closure, so this method just touches Postgres.
  async create(discordId: string, mood: MoodLog): Promise<void> {
    await prisma.mood.create({
      data: {
        userId: discordId,
        rating: mood.rating,
        emoji: mood.emoji,
        note: mood.note ?? null,
        context: mood.context ?? null,
      },
    });
  }

  async trend(discordId: string, days: number = 7): Promise<number> {
    const since = new Date(Date.now() - days * 86400000);
    const moods = await prisma.mood.findMany({
      where: {
        userId: discordId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    if (moods.length === 0) return 0;
    const sum = moods.reduce((acc, m) => acc + m.rating, 0);
    return Math.round((sum / moods.length) * 10) / 10;
  }

  static ratingToEmoji(rating: number): string {
    return MOOD_EMOJIS[rating] ?? '😐';
  }

  static isLowMood(rating: number): boolean {
    return rating <= 2;
  }
}
