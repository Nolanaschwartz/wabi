import { Injectable } from '@nestjs/common';
import { prisma, Prisma } from '@wabi/shared';
import { MemoryStoreService } from '../memory/memory-store.service';

/**
 * One source of a person's data. The whole point of declaring these in a single list is that
 * `export()` and `delete()` both derive from it — so the two can never drift, and adding a new
 * store is a single entry touched by both paths.
 *
 * (A prior gap proved why this matters: CoachingSession was missing from both hand-maintained
 * lists, so a `/data delete` silently orphaned it — ADR-0004/0011 say a person can always fully
 * delete their data.)
 */
interface UserDataSource {
  /** Export key. Omit for delete-only sources — internal bookkeeping we reap but never surface. */
  key?: string;
  /** Export reader, shaped exactly as the user-facing JSON. Omit ⇒ not exported. */
  read?: (discordId: string) => Promise<unknown>;
  /** Delete inside the atomic Prisma transaction. */
  delTx?: (tx: Prisma.TransactionClient, discordId: string) => Promise<unknown>;
  /** Delete outside the transaction — a different store (e.g. Mem0). */
  delExternal?: (discordId: string) => Promise<unknown>;
}

@Injectable()
export class DataRightsService {
  private readonly sources: UserDataSource[];

  constructor(private readonly memoryStore: MemoryStoreService) {
    this.sources = [
      {
        key: 'moods',
        read: (id) =>
          prisma.mood.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((m) => ({ rating: m.rating, emoji: m.emoji, note: m.note, createdAt: m.createdAt })),
          ),
        delTx: (tx, id) => tx.mood.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'playtime',
        read: (id) =>
          prisma.playtimeLog.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((p) => ({ duration: p.duration, game: p.game, createdAt: p.createdAt })),
          ),
        delTx: (tx, id) => tx.playtimeLog.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'journal',
        read: (id) =>
          prisma.journalEntry.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((j) => ({ content: j.content, reflection: j.reflection, createdAt: j.createdAt })),
          ),
        delTx: (tx, id) => tx.journalEntry.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'xp',
        read: (id) =>
          prisma.xpEntry.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((x) => ({ amount: x.amount, reason: x.reason, createdAt: x.createdAt })),
          ),
        delTx: (tx, id) => tx.xpEntry.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'escalations',
        read: (id) =>
          prisma.escalationEvent.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((e) => ({ layer: e.layer, timestamp: e.timestamp })),
          ),
        delTx: (tx, id) => tx.escalationEvent.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'sessions',
        read: (id) =>
          prisma.session.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((s) => ({ sessionId: s.id, expiresAt: s.expiresAt })),
          ),
        delTx: (tx, id) => tx.session.deleteMany({ where: { userId: id } }),
      },
      {
        key: 'tilt',
        read: (id) =>
          prisma.tiltSession.findMany({ where: { userId: id } }).then((rows) =>
            rows.map((t) => ({
              trigger: t.trigger,
              severity: t.severity,
              technique: t.technique,
              resolved: t.resolved,
              createdAt: t.createdAt,
            })),
          ),
        delTx: (tx, id) => tx.tiltSession.deleteMany({ where: { userId: id } }),
      },
      {
        // Delete-only. The Coaching Session row is internal bookkeeping (lastActivity, mined,
        // doNotMine) with no user-authored content — reaped on delete, never surfaced in export.
        // Keyed by discordId with no User FK, so onDelete: Cascade can't reach it; it must be
        // explicit. This is the row that was previously orphaned.
        delTx: (tx, id) => tx.coachingSession.deleteMany({ where: { discordId: id } }),
      },
      {
        key: 'memory',
        read: (id) =>
          this.memoryStore.getAllForUser(id).then((rows) =>
            rows.map((m) => ({ id: m.id, content: m.content })),
          ),
        delExternal: (id) => this.memoryStore.deleteAllForUser(id),
      },
    ];
  }

  async export(discordId: string): Promise<string> {
    const exportable = this.sources.filter((s) => s.key && s.read);

    const [user, entries] = await Promise.all([
      prisma.user.findUnique({ where: { discordId } }),
      Promise.all(exportable.map(async (s) => [s.key!, await s.read!(discordId)] as const)),
    ]);

    const data = {
      user: {
        discordId: user?.discordId,
        email: user?.email,
        locale: user?.locale,
        createdAt: user?.createdAt,
      },
      ...Object.fromEntries(entries),
    };

    return JSON.stringify(data, null, 2);
  }

  async delete(discordId: string): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        for (const s of this.sources) {
          if (s.delTx) await s.delTx(tx, discordId);
        }
      });
      // External stores (different store, not in the Prisma tx) are deleted after it commits.
      for (const s of this.sources) {
        if (s.delExternal) await s.delExternal(discordId);
      }
    } catch {
      // Best-effort delete
    }
  }
}
