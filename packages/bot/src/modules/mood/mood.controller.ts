import { Controller } from '@nestjs/common';
import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { MoodService } from './mood.service';

@Controller()
@SlashCommand({ name: 'mood', description: 'Log your mood' })
export class MoodController {
  constructor(private readonly moodService: MoodService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply();

    const opts = (interaction as any).options;
    const subcommand = opts?.getSubcommand();

    if (subcommand === 'log') {
      const rating = Math.max(1, Math.min(5, opts?.getInteger('rating') ?? 3));
      const note = opts?.getString('note') ?? undefined;
      const emoji = MoodService.ratingToEmoji(rating);

      await this.moodService.log(interaction.user.id, { rating, emoji, note });

      const trend = await this.moodService.trend(interaction.user.id);
      const trendText = trend > 0 ? `\nYour ${Math.round(trend * 10) / 10}-day average: ${'⭐'.repeat(Math.round(trend))}` : '';

      const followUp = MoodService.isLowMood(rating)
        ? "I'm sorry you're feeling down. Want to talk about it?"
        : "Thanks for checking in.";

      await interaction.editReply({
        content: `${emoji} Mood logged.${trendText}\n${followUp}`,
      });
      return;
    }

    await interaction.editReply({
      content: "Usage: `/mood log rating:1-5 note:optional`",
    });
  }
}

@SlashCommand({ name: 'feeling', description: 'Quick mood check-in' })
export class FeelingController {
  constructor(private readonly moodService: MoodService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opts = (interaction as any).options;
    const rating = opts?.getNumber('rating') ?? 3;
    const emoji = MoodService.ratingToEmoji(rating);

    await this.moodService.log(interaction.user.id, {
      rating,
      emoji,
    });

    const followUp = MoodService.isLowMood(rating)
      ? "I'm sorry you're feeling down. Want to talk about it?"
      : "Thanks for sharing how you feel. I'm here if you want to chat.";

    await interaction.editReply({
      content: `${emoji} Logged your mood. ${followUp}`,
    });
  }
}
