import { Injectable } from '@nestjs/common';
import { prisma, Prisma } from '@wabi/shared';

@Injectable()
export class UserService {
  async findByDiscordId(
    discordId: string,
    select?: Prisma.UserSelect,
  ) {
    return prisma.user.findUnique({
      where: { discordId },
      select,
    });
  }
}
