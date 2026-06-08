import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  IntegerOption,
  StringOption,
  SlashCommandContext,
  Subcommand,
  createCommandGroupDecorator,
} from 'necord';
import { CommandInteraction } from 'discord.js';
import { PlaytimeService } from './playtime.service';
import { MemoryStoreService } from '../memory/memory-store.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export const PlaytimeCommandGroup = createCommandGroupDecorator({
  name: 'playtime',
  description: 'Log and track playtime',
  ...COMMAND_CONTEXTS,
});

export class PlaytimeLogDto {
  @IntegerOption({
    name: 'duration',
    description: 'How many minutes you played',
    required: true,
    min_value: 1,
  })
  duration!: number;

  @StringOption({
    name: 'game',
    description: 'What you played (optional)',
    required: false,
  })
  game?: string;
}

@Injectable()
@PlaytimeCommandGroup()
export class PlaytimeController {
  constructor(
    private readonly playtimeService: PlaytimeService,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  @Subcommand({ name: 'log', description: 'Log a play session' })
  async log(
    @Context() [interaction]: SlashCommandContext,
    @Options() { duration, game }: PlaytimeLogDto,
  ): Promise<void> {
    await interaction.deferReply();
    await this.handleLog(interaction, Math.max(1, duration ?? 0), game ?? undefined);
  }

  @Subcommand({ name: 'stats', description: 'View your 7-day playtime stats' })
  async stats(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();
    await this.handleStats(interaction);
  }

  private async handleLog(
    interaction: CommandInteraction,
    duration: number,
    game: string | undefined,
  ): Promise<void> {
    await this.playtimeService.log(interaction.user.id, { duration, game });

    const headsUp = PlaytimeService.isLongSession(duration)
      ? `\n${PlaytimeService.gentleHeadsUp(duration)}`
      : '';

    if (PlaytimeService.isLongSession(duration)) {
      await this.memoryStore.deriveAndStore(interaction.user.id, `Long play session: ${duration} minutes${game ? ` of ${game}` : ''}`);
    }

    await interaction.editReply({
      content: `Playtime logged: ${duration} minutes${game ? ` of ${game}` : ''}.${headsUp}`,
    });
  }

  private async handleStats(interaction: CommandInteraction): Promise<void> {
    const stats = await this.playtimeService.stats(interaction.user.id, 7);
    const statusEmoji = stats.status === 'healthy' ? '✅' : '⚠️';

    await interaction.editReply({
      content: `**7-day playtime stats**\n${statusEmoji} Total: ${stats.total} minutes\n📊 Daily average: ${stats.dailyAvg} minutes\n${stats.status === 'healthy' ? 'You\'re in a healthy range!' : 'Consider taking more breaks between sessions.'}`,
    });
  }
}
