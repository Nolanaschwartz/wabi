import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { MessageFlags } from 'discord.js';
import { HabitEngagementService } from './habit-engagement.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

/**
 * The `/profile` command — a person's wellness profile (XP, Streak, Wellness Score). It reads the
 * Engagement read model (ADR-0027), so it lives with HabitEngagementService rather than in StreaksModule
 * (the command shows the whole engagement view, not streaks alone; routing it through the engagement
 * seam also keeps StreaksService free of any XP dependency).
 */
@Injectable()
export class ProfileController {
  constructor(private readonly engagement: HabitEngagementService) {}

  @SlashCommand({ name: 'profile', description: 'View your wellness profile', ...COMMAND_CONTEXTS })
  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const profile = await this.engagement.profile(interaction.user.id);

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
