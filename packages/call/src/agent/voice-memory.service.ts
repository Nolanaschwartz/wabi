import { Injectable, Logger } from '@nestjs/common';
import type { VoiceBasedChannel } from 'discord.js';
import { prisma, recall } from '@wabi/shared';
import { buildMemoryContext, type CallMember } from './memory-context';

/**
 * Adapts a live Discord voice channel to the pure {@link buildMemoryContext} decision: maps members,
 * confirms the one human is a known wabi User, and recalls from Mem0. The privacy gate (single-human
 * only, ADR-0002) lives in buildMemoryContext; this service is just glue.
 *
 * Recall is keyed by the DISCORD id, the same mem0 partition the coaching bot writes under
 * (session-sweeper.service.ts derives memory under `session.discordId` → `mem0_<discordId>`; data-rights
 * deletes the same key). Keying by the wabi User.id instead reads an empty partition, so the assistant
 * forgets everything the coach learned — the existence check below only gates *whether* to recall
 * (unknown DMs get nothing, the DM rule on voice), never the key.
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
        // Known user → recall by their Discord id (the bot's mem0 key); unknown → null (no recall).
        resolveUserId: async (discordId) =>
          (await prisma.user.findUnique({ where: { discordId } })) ? discordId : null,
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
