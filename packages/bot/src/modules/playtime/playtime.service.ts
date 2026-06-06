import { prisma } from '@wabi/shared';

const DAILY_AVG_TARGET = 120; // minutes
const SESSION_LENGTH_THRESHOLD = 120; // minutes

export interface PlaytimeLog {
  duration: number;
  game?: string;
}

export class PlaytimeService {
  async log(discordId: string, log: PlaytimeLog): Promise<void> {
    await prisma.playtimeLog.create({
      data: {
        userId: discordId,
        duration: log.duration,
        game: log.game ?? null,
      },
    });
  }

  async stats(discordId: string, days: number = 7): Promise<{
    total: number;
    dailyAvg: number;
    status: 'healthy' | 'over';
  }> {
    const since = new Date(Date.now() - days * 86400000);
    const logs = await prisma.playtimeLog.findMany({
      where: {
        userId: discordId,
        createdAt: { gte: since },
      },
    });

    const total = logs.reduce((acc, l) => acc + l.duration, 0);
    const dailyAvg = logs.length > 0 ? Math.round(total / days) : 0;
    const status = dailyAvg > DAILY_AVG_TARGET ? 'over' : 'healthy';

    return { total, dailyAvg, status };
  }

  static isLongSession(duration: number): boolean {
    return duration >= SESSION_LENGTH_THRESHOLD;
  }

  static gentleHeadsUp(duration: number): string {
    const hours = Math.floor(duration / 60);
    const mins = duration % 60;
    const timeStr = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `That's ${timeStr} of playtime. Remember to take breaks and stretch!`;
  }
}
