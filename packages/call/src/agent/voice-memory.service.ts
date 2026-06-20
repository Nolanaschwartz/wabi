import { Injectable, Logger } from '@nestjs/common';
import type { VoiceBasedChannel } from 'discord.js';
import { prisma } from '@wabi/shared';
import { buildMemoryContext, type CallMember } from './memory-context';
import { recall } from './mem0';

/**
 * Adapts a live Discord voice channel to the pure {@link buildMemoryContext} decision: maps members,
 * resolves the one human's Discord id to their wabi User via Prisma, and recalls from Mem0. The
 * privacy gate (single-human only, ADR-0002) lives in buildMemoryContext; this service is just glue.
 *
 * Fails open: any identity/recall error yields '' (a plain assistant), so a degraded Postgres/Mem0
 * never breaks the call — matching the bot's fail-open posture.
 */
@Injectable()
export class VoiceMemoryService {
  private readonly log = new Logger(VoiceMemoryService.name);

  async contextFor(channel: VoiceBasedChannel): Promise<string> {
    try {
      const members: CallMember[] = channel.members.map((m) => ({
        id: m.id,
        isBot: m.user.bot,
      }));
      return await buildMemoryContext({
        members,
        resolveUserId: async (discordId) =>
          (await prisma.user.findUnique({ where: { discordId } }))?.id ?? null,
        recall,
      });
    } catch (err) {
      this.log.warn(
        `memory recall failed, continuing without it: ${(err as Error).message}`,
      );
      return '';
    }
  }
}
