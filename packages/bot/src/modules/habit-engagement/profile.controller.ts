import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { MessageFlags } from 'discord.js';
import { HabitEngagementService } from './habit-engagement.service';
import { AccessResolver } from '../billing/access-resolver';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

/**
 * The `/profile` command — a person's wellness profile (XP, Streak, Wellness Score). It reads the
 * Engagement read model (ADR-0027), so it lives with HabitEngagementService rather than in StreaksModule
 * (the command shows the whole engagement view, not streaks alone; routing it through the engagement
 * seam also keeps StreaksService free of any XP dependency).
 */
@Injectable()
export class ProfileController {
  constructor(
    private readonly engagement: HabitEngagementService,
    private readonly accessResolver: AccessResolver,
  ) {}

  @SlashCommand({ name: 'profile', description: 'View your wellness profile', ...COMMAND_CONTEXTS })
  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Resolve the person's timezone from the SAME source the coaching path uses (AccessResolver),
      // so the Streak and Wellness Score on /profile bucket day boundaries identically to the coaching
      // reply and agree on the number (defaults to 'UTC' when unset).
      const { timezone } = await this.accessResolver.resolveAccount(interaction.user.id);
      const profile = await this.engagement.profile(interaction.user.id, timezone);

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
