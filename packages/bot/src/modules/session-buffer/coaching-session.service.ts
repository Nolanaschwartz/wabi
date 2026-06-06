import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';

const SESSION_IDLE_MS = 30 * 60 * 1000;

@Injectable()
export class CoachingSessionService {
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
    await prisma.coachingSession.update({
      where: { discordId },
      data: { doNotMine: true },
    }).catch(() => {
      // Session may not exist yet — no-op
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
