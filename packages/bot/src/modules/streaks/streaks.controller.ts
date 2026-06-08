import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { MessageFlags } from 'discord.js';
import { StreaksService } from './streaks.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

@Injectable()
export class StreaksController {
  constructor(private readonly streaksService: StreaksService) {}

  @SlashCommand({ name: 'profile', description: 'View your wellness profile', ...COMMAND_CONTEXTS })
  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const profile = await this.streaksService.profile(interaction.user.id);

      await interaction.editReply({
        content: `**${interaction.user.username}'s Profile**

🎮 **XP**: ${profile.xp}
🔥 **Streak**: ${profile.streak} days
📊 **Wellness Score**: ${profile.wellnessScore}/100
${profile.wellnessLevel}`,
      });
    } catch {
      await interaction.editReply({
        content: 'Failed to load profile. Please try again.',
      });
    }
  }
}
