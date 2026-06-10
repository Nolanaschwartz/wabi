import { prisma } from '@wabi/shared';

export async function getDbUser(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}
