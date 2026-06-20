import { prisma } from '@wabi/shared';

/**
 * Load the web User row by its id. Single point through which all by-id User
 * reads in web flow, so a future change (adding a `select` to stop over-fetching,
 * routing through a cache) is made in one place.
 */
export function getDbUser(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}
