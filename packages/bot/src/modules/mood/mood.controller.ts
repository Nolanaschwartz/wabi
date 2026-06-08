import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  IntegerOption,
  NumberOption,
  StringOption,
  SlashCommand,
  SlashCommandContext,
  Subcommand,
  createCommandGroupDecorator,
} from 'necord';
import { MessageFlags } from 'discord.js';
import { MoodService } from './mood.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export const MoodCommandGroup = createCommandGroupDecorator({
  name: 'mood',
  description: 'Log your mood',
  ...COMMAND_CONTEXTS,
});

export class MoodLogDto {
  @IntegerOption({
    name: 'rating',
    description: 'How you feel, 1 (low) to 5 (great)',
    required: true,
    min_value: 1,
    max_value: 5,
  })
  rating!: number;

  @StringOption({
    name: 'note',
    description: 'Optional note about how you feel',
    required: false,
  })
  note?: string;
}

@Injectable()
@MoodCommandGroup()
export class MoodController {
  constructor(private readonly moodService: MoodService) {}

  @Subcommand({ name: 'log', description: 'Log your mood with a rating' })
  async log(
    @Context() [interaction]: SlashCommandContext,
    @Options() { rating, note }: MoodLogDto,
  ): Promise<void> {
    await interaction.deferReply();

    const clamped = Math.max(1, Math.min(5, rating ?? 3));
    const emoji = MoodService.ratingToEmoji(clamped);

    await this.moodService.log(interaction.user.id, {
      rating: clamped,
      emoji,
      note: note ?? undefined,
    });

    const trend = await this.moodService.trend(interaction.user.id);
    const trendText = trend > 0 ? `\nYour ${Math.round(trend * 10) / 10}-day average: ${'⭐'.repeat(Math.round(trend))}` : '';

    const followUp = MoodService.isLowMood(clamped)
      ? "I'm sorry you're feeling down. Want to talk about it?"
      : "Thanks for checking in.";

    await interaction.editReply({
      content: `${emoji} Mood logged.${trendText}\n${followUp}`,
    });
  }
}

export class FeelingDto {
  @NumberOption({
    name: 'rating',
    description: 'How you feel right now, 1 (low) to 5 (great)',
    required: false,
  })
  rating?: number;
}

@Injectable()
export class FeelingController {
  constructor(private readonly moodService: MoodService) {}

  @SlashCommand({ name: 'feeling', description: 'Quick mood check-in', ...COMMAND_CONTEXTS })
  async execute(
    @Context() [interaction]: SlashCommandContext,
    @Options() { rating }: FeelingDto,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const value = rating ?? 3;
    const emoji = MoodService.ratingToEmoji(value);

    await this.moodService.log(interaction.user.id, {
      rating: value,
      emoji,
    });

    const followUp = MoodService.isLowMood(value)
      ? "I'm sorry you're feeling down. Want to talk about it?"
      : "Thanks for sharing how you feel. I'm here if you want to chat.";

    await interaction.editReply({
      content: `${emoji} Logged your mood. ${followUp}`,
    });
  }
}
