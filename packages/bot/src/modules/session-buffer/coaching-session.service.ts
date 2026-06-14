import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { JsonLogger } from '../../lib/json-logger';

const SESSION_IDLE_MS = 30 * 60 * 1000;

@Injectable()
export class CoachingSessionService {
  private readonly logger = new JsonLogger(CoachingSessionService.name);
  async touch(discordId: string) {
    return prisma.coachingSession.upsert({
      where: { discordId },
      create: {
        discordId,
        expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
      },
      update: {
        lastActivity: new Date(),
        expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
      },
    });
  }

  async endStale(idleMs: number = SESSION_IDLE_MS) {
    const cutoff = new Date(Date.now() - idleMs);

    return prisma.coachingSession.findMany({
      where: {
        lastActivity: { lt: cutoff },
        mined: false,
      },
    });
  }

  async markMined(sessionId: string) {
    await prisma.coachingSession.update({
      where: { id: sessionId },
      data: { mined: true },
    });
  }

  async quarantine(discordId: string) {
    // Upsert so a tripwire-first crisis (no prior coaching turn -> no session row) still
    // records the do-not-mine flag. This Postgres column is the single source of truth the
    // sweeper reads (issue #24 / ADR-0010/0016).
    await prisma.coachingSession
      .upsert({
        where: { discordId },
        create: {
          discordId,
          expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
          doNotMine: true,
        },
        update: { doNotMine: true },
      })
      .catch((err) => {
        this.logger.error('quarantine failed', { discordId, error: err instanceof Error ? err.message : String(err) });
      });
  }

  async isQuarantined(discordId: string): Promise<boolean> {
    const session = await prisma.coachingSession.findUnique({
      where: { discordId },
      select: { doNotMine: true },
    });

    return session?.doNotMine ?? false;
  }

  async deleteSession(discordId: string) {
    await prisma.coachingSession.delete({
      where: { discordId },
    }).catch(() => {
      // Session may not exist — no-op
    });
  }
}
