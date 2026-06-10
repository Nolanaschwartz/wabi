import { Injectable } from '@nestjs/common';
import {
  Button,
  ButtonContext,
  Context,
  SlashCommand,
  SlashCommandContext,
} from 'necord';
import { MessageFlags } from 'discord.js';
import { InnerStateConsentService } from './inner-state-consent.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

/**
 * The Discord surface for inner-state memory consent (ADR-0029): the `/memory` command and the
 * buttons appended to a first free-text log. All logic lives in InnerStateConsentService; this is
 * thin necord glue. These are the only message-component buttons in the bot.
 */
@Injectable()
export class MemoryConsentController {
  constructor(private readonly consent: InnerStateConsentService) {}

  @SlashCommand({
    name: 'memory',
    description: 'Choose whether your coach remembers your journal, mood, and tilt notes',
    ...COMMAND_CONTEXTS,
  })
  async memory(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const enabled = await this.consent.isEnabled(interaction.user.id);
    const status = this.consent.buildStatus(enabled);
    await interaction.editReply({ content: status.content, components: status.components });
  }

  @Button(InnerStateConsentService.REMEMBER_ID)
  async onRemember(@Context() [interaction]: ButtonContext): Promise<void> {
    await this.consent.grant(interaction.user.id);
    await interaction.update({
      content:
        "✅ Got it — I'll use your notes as memory for our chats. Turn this off anytime with `/memory`.",
      components: [],
    });
  }

  @Button(InnerStateConsentService.KEEP_PRIVATE_ID)
  async onKeepPrivate(@Context() [interaction]: ButtonContext): Promise<void> {
    await this.consent.decline(interaction.user.id);
    await interaction.update({
      content:
        "👍 Kept private — I won't use your notes as memory. You can turn it on anytime with `/memory`.",
      components: [],
    });
  }

  @Button(InnerStateConsentService.TOGGLE_ID)
  async onToggle(@Context() [interaction]: ButtonContext): Promise<void> {
    const enabled = await this.consent.toggle(interaction.user.id);
    const status = this.consent.buildStatus(enabled);
    await interaction.update({ content: status.content, components: status.components });
  }
}
