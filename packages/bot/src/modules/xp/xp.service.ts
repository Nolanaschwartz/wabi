import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';

@Injectable()
export class XpService {
  async award(
    discordId: string,
    amount: number,
    reason: string,
    engagedDay: string,
  ): Promise<void> {
    // engagedDay is the person-tz calendar day ("YYYY-MM-DD"); the (userId, engagedDay) unique index
    // makes "one Engagement per engaged day" race-proof (ADR-0027) — a duplicate insert throws P2002,
    // which the single writer treats as benign.
    await prisma.xpEntry.create({
      data: {
        userId: discordId,
        amount,
        reason,
        engagedDay,
      },
    });
  }

  async total(discordId: string): Promise<number> {
    // Sum in the database rather than loading every row and reducing in JS, so the read does not
    // scale with a person's history length. `_sum.amount` is null when no rows match → coalesce to 0.
    const { _sum } = await prisma.xpEntry.aggregate({
      _sum: { amount: true },
      where: { userId: discordId },
    });

    return _sum.amount ?? 0;
  }

  async recent(discordId: string, limit: number = 5): Promise<Array<{
    amount: number;
    reason: string;
    createdAt: Date;
  }>> {
    const entries = await prisma.xpEntry.findMany({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        amount: true,
        reason: true,
        createdAt: true,
      },
    });

    return entries;
  }
}
