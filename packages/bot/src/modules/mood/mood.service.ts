import { Injectable } from '@nestjs/common';
import { prisma, ratingToEmoji } from '@wabi/shared';
import { ScreenedText } from '../crisis/screened';

export interface MoodRecord {
  rating: number;
  emoji: string;
}

@Injectable()
export class MoodService {
  // Structured-only write: a rating + emoji, NEVER free text. The DM mood spoke calls this directly
  // (it captures no note); a future surface that wants to persist a note has no `ScreenedText` to hand
  // `create`, so it is structurally barred from doing so and must route through `createNote` instead
  // (ADR-0028/0031). This method just touches Postgres.
  async create(discordId: string, mood: MoodRecord): Promise<void> {
    await prisma.mood.create({
      data: {
        userId: discordId,
        rating: mood.rating,
        emoji: mood.emoji,
        note: null,
        context: null,
      },
    });
  }

  // A mood with a free-text note. The note is a `ScreenedText` proof, not a bare string, so the note
  // structurally cannot reach Postgres unscreened (ADR-0028/0031): `note.freeText` is the exact
  // crisis-safe text the upstream screen cleared, byte-identical to what was derived to Memory.
  async createNote(
    discordId: string,
    base: MoodRecord,
    note: ScreenedText,
  ): Promise<void> {
    await prisma.mood.create({
      data: {
        userId: discordId,
        rating: base.rating,
        emoji: base.emoji,
        note: note.freeText,
        context: null,
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
    return ratingToEmoji(rating);
  }

  static isLowMood(rating: number): boolean {
    return rating <= 2;
  }
}
