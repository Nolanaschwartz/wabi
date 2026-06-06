import { prisma } from '@wabi/shared';

export class XpService {
  async award(
    discordId: string,
    amount: number,
    reason: string,
  ): Promise<void> {
    await prisma.xpEntry.create({
      data: {
        userId: discordId,
        amount,
        reason,
      },
    });
  }

  async total(discordId: string): Promise<number> {
    const entries = await prisma.xpEntry.findMany({
      where: { userId: discordId },
    });

    return entries.reduce((acc, e) => acc + e.amount, 0);
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
