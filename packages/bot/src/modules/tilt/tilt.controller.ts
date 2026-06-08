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
import { TiltService } from './tilt.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export const TiltCommandGroup = createCommandGroupDecorator({
  name: 'tilt',
  description: 'Manage tilt sessions',
  ...COMMAND_CONTEXTS,
});

export class TiltStartDto {
  @StringOption({
    name: 'trigger',
    description: 'What set you off',
    required: false,
  })
  trigger?: string;

  @IntegerOption({
    name: 'severity',
    description: 'How bad it feels, 1-10',
    required: false,
    min_value: 1,
    max_value: 10,
  })
  severity?: number;
}

@Injectable()
@TiltCommandGroup()
export class TiltController {
  constructor(private readonly tiltService: TiltService) {}

  @Subcommand({ name: 'start', description: 'Start a tilt session' })
  async start(
    @Context() [interaction]: SlashCommandContext,
    @Options() { trigger, severity }: TiltStartDto,
  ): Promise<void> {
    await interaction.deferReply();
    await this.handleStart(
      interaction,
      trigger ?? 'unknown',
      Math.max(1, Math.min(10, severity ?? 5)),
    );
  }

  @Subcommand({ name: 'resolve', description: 'Resolve your current tilt session' })
  async resolve(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();
    await this.handleResolve(interaction);
  }

  @Subcommand({ name: 'stats', description: 'View your tilt stats' })
  async stats(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();
    await this.handleStats(interaction);
  }

  private async handleStart(
    interaction: CommandInteraction,
    trigger: string,
    severity: number,
  ): Promise<void> {
    const technique = await this.tiltService.start(interaction.user.id, {
      trigger,
      severity,
    });

    await interaction.editReply({
      content: `Tilt session started. Trigger: ${trigger} (Severity: ${severity}/10)\n\nReset technique: ${technique}`,
    });
  }

  private async handleResolve(interaction: CommandInteraction): Promise<void> {
    await this.tiltService.resolve(interaction.user.id);

    await interaction.editReply({
      content: 'Tilt session resolved. Good job taking a step back.',
    });
  }

  private async handleStats(interaction: CommandInteraction): Promise<void> {
    const stats = await this.tiltService.stats(interaction.user.id);

    const triggersText = stats.commonTriggers.length > 0
      ? `\n🔥 Common triggers:\n${stats.commonTriggers.map((t) => `• ${t.trigger} (${t.count}x)`).join('\n')}`
      : '';

    await interaction.editReply({
      content: `**Tilt Stats**\n📊 Total sessions: ${stats.total}\n⚡ Average severity: ${stats.avgSeverity}/10${triggersText}`,
    });
  }
}
