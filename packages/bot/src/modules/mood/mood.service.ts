import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import {
  CrisisScreeningService,
  ScreenedRecord,
} from '../crisis/crisis-screening.service';

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
  constructor(private readonly screening: CrisisScreeningService) {}

  // The mood `note` is free text a person can express distress into, so it crosses the shared
  // screened-record path before the record is written (ADR-0028). A crisis note escalates and is not
  // persisted; the controller renders the returned resources.
  async log(discordId: string, mood: MoodLog): Promise<ScreenedRecord<void>> {
    return this.screening.guard(discordId, mood.note, async () => {
      await prisma.mood.create({
        data: {
          userId: discordId,
          rating: mood.rating,
          emoji: mood.emoji,
          note: mood.note ?? null,
          context: mood.context ?? null,
        },
      });
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
