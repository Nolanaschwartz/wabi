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
import { MoodService } from './mood.service';
import { InnerStateLoggerService } from '../inner-state-logger/inner-state-logger.service';
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
  constructor(
    private readonly moodService: MoodService,
    private readonly logger: InnerStateLoggerService,
  ) {}

  @Subcommand({ name: 'log', description: 'Log your mood with a rating' })
  async log(
    @Context() [interaction]: SlashCommandContext,
    @Options() { rating, note }: MoodLogDto,
  ): Promise<void> {
    const clamped = Math.max(1, Math.min(5, rating ?? 3));
    const emoji = MoodService.ratingToEmoji(clamped);

    // The note is the one free-text field; the logger screens it, derives it (prefixed), and offers
    // the at-most-once consent prompt. A rating-only log carries no free text, so none of that runs.
    await this.logger.log({
      interaction,
      freeText: { value: note, derivePrefix: 'Mood note' },
      // The 7-day trend is awaited here (inside the safe-path closure) and threaded through T, so the
      // synchronous confirm can render it without an await of its own.
      persist: async () => {
        await this.moodService.create(interaction.user.id, {
          rating: clamped,
          emoji,
          note,
        });
        return { trend: await this.moodService.trend(interaction.user.id) };
      },
      confirm: ({ trend }) => {
        const trendText =
          trend > 0
            ? `\nYour ${Math.round(trend * 10) / 10}-day average: ${'⭐'.repeat(Math.round(trend))}`
            : '';
        const followUp = MoodService.isLowMood(clamped)
          ? "I'm sorry you're feeling down. Want to talk about it?"
          : 'Thanks for checking in.';
        return `${emoji} Mood logged.${trendText}\n${followUp}`;
      },
    });
  }
}

export class FeelingDto {
  @NumberOption({
    name: 'rating',
    description: 'How you feel right now, 1 (low) to 5 (great)',
    required: false,
    min_value: 1,
    max_value: 5,
  })
  rating?: number;
}

@Injectable()
export class FeelingController {
  constructor(
    private readonly moodService: MoodService,
    private readonly logger: InnerStateLoggerService,
  ) {}

  @SlashCommand({ name: 'feeling', description: 'Quick mood check-in', ...COMMAND_CONTEXTS })
  async execute(
    @Context() [interaction]: SlashCommandContext,
    @Options() { rating }: FeelingDto,
  ): Promise<void> {
    // rating is a float NumberOption, so round + clamp to the 1..5 Int column before persisting
    // (Discord enforces the min/max, but a client could still send a fractional value).
    const value = Math.max(1, Math.min(5, Math.round(rating ?? 3)));
    const emoji = MoodService.ratingToEmoji(value);
    const followUp = MoodService.isLowMood(value)
      ? "I'm sorry you're feeling down. Want to talk about it?"
      : "Thanks for sharing how you feel. I'm here if you want to chat.";

    // /feeling has no free-text field — a rating-only check-in — but it still routes through the
    // logger (no freeText) so there is no mood-render path that bypasses screening.
    await this.logger.log({
      interaction,
      persist: async () => {
        await this.moodService.create(interaction.user.id, { rating: value, emoji });
      },
      confirm: () => `${emoji} Logged your mood. ${followUp}`,
    });
  }
}
