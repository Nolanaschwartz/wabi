import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { UserService } from '../user/user.service';

/**
 * One Discord component row plus the copy that introduces it — the shape every consent surface
 * (first-use prompt and the `/memory` status reply) hands back to a controller to render.
 */
export interface ConsentSurface {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * Owns the "does this person let their coach remember their notes?" decision and the one-time ask
 * (ADR-0029). All three free-text fields, the `/memory` command, and the buttons share this single
 * seam, so "prompted at most once across every field" is structural: the prompt is shown — and the
 * person marked as asked — in exactly one place.
 *
 * Default is off. Silence (a shown-but-ignored prompt) leaves memory off, which is the
 * privacy-preserving outcome for a wellness product handling private notes.
 */
@Injectable()
export class InnerStateConsentService {
  static readonly REMEMBER_ID = 'inner_state_memory:remember';
  static readonly KEEP_PRIVATE_ID = 'inner_state_memory:keep_private';
  static readonly TOGGLE_ID = 'inner_state_memory:toggle';

  constructor(private readonly userService: UserService) {}

  /**
   * If this person has neither opted in nor been asked, mark them asked *now* and return the
   * first-use prompt to append to the current reply. Otherwise return null — we never re-prompt.
   * Marking on display (not on click) is what makes the ask happen at most once across all fields.
   */
  async prepareFirstUsePrompt(userId: string): Promise<ConsentSurface | null> {
    const user = await this.userService.findByDiscordId(userId, {
      innerStateMemoryEnabled: true,
      innerStateMemoryPromptedAt: true,
    });

    if (!user || user.innerStateMemoryEnabled || user.innerStateMemoryPromptedAt) {
      return null;
    }

    await prisma.user.update({
      where: { discordId: userId },
      data: { innerStateMemoryPromptedAt: new Date() },
    });

    return this.buildFirstUsePrompt();
  }

  /** [Remember my notes] — opt in, and record the answer. */
  async grant(userId: string): Promise<void> {
    await prisma.user.update({
      where: { discordId: userId },
      data: { innerStateMemoryEnabled: true, innerStateMemoryPromptedAt: new Date() },
    });
  }

  /** [Keep private] — stay opted out, but record that they were asked so we don't ask again. */
  async decline(userId: string): Promise<void> {
    await prisma.user.update({
      where: { discordId: userId },
      data: { innerStateMemoryPromptedAt: new Date() },
    });
  }

  /** `/memory` toggle — flip in either direction and return the new state. */
  async toggle(userId: string): Promise<boolean> {
    const user = await this.userService.findByDiscordId(userId, {
      innerStateMemoryEnabled: true,
    });
    const next = !user?.innerStateMemoryEnabled;
    await prisma.user.update({
      where: { discordId: userId },
      data: { innerStateMemoryEnabled: next, innerStateMemoryPromptedAt: new Date() },
    });
    return next;
  }

  async isEnabled(userId: string): Promise<boolean> {
    const user = await this.userService.findByDiscordId(userId, {
      innerStateMemoryEnabled: true,
    });
    return !!user?.innerStateMemoryEnabled;
  }

  buildFirstUsePrompt(): ConsentSurface {
    const content = [
      '💭 **Want me to remember your notes?**',
      '',
      'If you turn this on, I can use your **journal**, **mood**, and **tilt** notes as memory for',
      'future chats — so I remember your context instead of starting fresh each time.',
      '',
      '• Off by default — your call. Turn it on or off anytime with `/memory`.',
      "• Turning it off later stops *new* remembering, but doesn't erase what's already saved.",
      '• To remove saved memories entirely, use `/data delete` (your data-rights request).',
      '',
      'Your note is saved either way — this only controls memory.',
    ].join('\n');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(InnerStateConsentService.REMEMBER_ID)
        .setLabel('Remember my notes')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(InnerStateConsentService.KEEP_PRIVATE_ID)
        .setLabel('Keep private')
        .setStyle(ButtonStyle.Secondary),
    );

    return { content, components: [row] };
  }

  buildStatus(enabled: boolean): ConsentSurface {
    const content = [
      `💭 **Remembering your notes: ${enabled ? 'On' : 'Off'}**`,
      '',
      enabled
        ? 'I can use your journal, mood, and tilt notes as memory for our chats.'
        : "I'm not using your journal, mood, or tilt notes as memory.",
      '',
      "Turning it off stops *new* remembering but doesn't erase what's already saved — use",
      '`/data delete` to remove saved memories entirely.',
    ].join('\n');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(InnerStateConsentService.TOGGLE_ID)
        .setLabel(enabled ? 'Turn off' : 'Turn on')
        .setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );

    return { content, components: [row] };
  }
}
