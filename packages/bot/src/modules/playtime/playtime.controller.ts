import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { CommandInteraction } from 'discord.js';
import { PlaytimeService } from './playtime.service';
import { MemoryStoreService } from '../memory/memory-store.service';

@Injectable()
@SlashCommand({ name: 'playtime', description: 'Log and track playtime' })
export class PlaytimeController {
  constructor(
    private readonly playtimeService: PlaytimeService,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();

    const opts = (interaction as any).options;
    const subcommand = opts?.getSubcommand();

    if (subcommand === 'log') {
      await this.handleLog(interaction);
    } else if (subcommand === 'stats') {
      await this.handleStats(interaction);
    } else {
      await interaction.editReply({
        content: "Usage: `/playtime log duration:minutes game:optional` or `/playtime stats`",
      });
    }
  }

  private async handleLog(interaction: CommandInteraction): Promise<void> {
    const opts = (interaction as any).options;
    const duration = Math.max(1, opts?.getInteger('duration') ?? 0);
    const game = opts?.getString('game') ?? undefined;

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
