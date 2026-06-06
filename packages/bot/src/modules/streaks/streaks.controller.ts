import { Injectable } from '@nestjs/common';
import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { StreaksService } from './streaks.service';

@Injectable()
@SlashCommand({ name: 'profile', description: 'View your wellness profile' })
export class StreaksController {
  constructor(private readonly streaksService: StreaksService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

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
