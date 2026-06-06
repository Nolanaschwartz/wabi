import { prisma } from '@wabi/shared';
import { MemoryStoreService } from '../memory/memory-store.service';

export class DataRightsService {
  constructor(
    private readonly memoryStore: MemoryStoreService,
  ) {}

  async export(discordId: string): Promise<string> {
    const [user, moods, playtimes, journals, xps, escalations, sessions] =
      await Promise.all([
        prisma.user.findUnique({ where: { discordId } }),
        prisma.mood.findMany({ where: { userId: discordId } }),
        prisma.playtimeLog.findMany({ where: { userId: discordId } }),
        prisma.journalEntry.findMany({ where: { userId: discordId } }),
        prisma.xpEntry.findMany({ where: { userId: discordId } }),
        prisma.escalationEvent.findMany({ where: { userId: discordId } }),
        prisma.session.findMany({ where: { userId: discordId } }),
      ]);

    const data = {
      user: {
        discordId: user?.discordId,
        email: user?.email,
        locale: user?.locale,
        createdAt: user?.createdAt,
      },
      moods: moods.map((m) => ({
        rating: m.rating,
        emoji: m.emoji,
        note: m.note,
        createdAt: m.createdAt,
      })),
      playtime: playtimes.map((p) => ({
        duration: p.duration,
        game: p.game,
        createdAt: p.createdAt,
      })),
      journal: journals.map((j) => ({
        content: j.content,
        reflection: j.reflection,
        createdAt: j.createdAt,
      })),
      xp: xps.map((x) => ({
        amount: x.amount,
        reason: x.reason,
        createdAt: x.createdAt,
      })),
      escalations: escalations.map((e) => ({
        layer: e.layer,
        timestamp: e.timestamp,
      })),
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        expiresAt: s.expiresAt,
      })),
    };

    return JSON.stringify(data, null, 2);
  }

  async delete(discordId: string): Promise<void> {
    await this.memoryStore.deleteAllForUser(discordId);

    await prisma.mood.deleteMany({ where: { userId: discordId } });
    await prisma.playtimeLog.deleteMany({ where: { userId: discordId } });
    await prisma.journalEntry.deleteMany({ where: { userId: discordId } });
    await prisma.xpEntry.deleteMany({ where: { userId: discordId } });
    await prisma.escalationEvent.deleteMany({ where: { userId: discordId } });
    await prisma.session.deleteMany({ where: { userId: discordId } });
  }
}
