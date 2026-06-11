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
import { CommandInteraction, MessageFlags } from 'discord.js';
import { TiltService } from './tilt.service';
import { InnerStateLoggerService } from '../inner-state-logger/inner-state-logger.service';
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
  constructor(
    private readonly tiltService: TiltService,
    private readonly logger: InnerStateLoggerService,
  ) {}

  @Subcommand({ name: 'start', description: 'Start a tilt session' })
  async start(
    @Context() [interaction]: SlashCommandContext,
    @Options() { trigger, severity }: TiltStartDto,
  ): Promise<void> {
    const clampedSeverity = Math.max(1, Math.min(10, severity ?? 5));
    // The raw trigger is the one free-text field. The stored trigger falls back to 'unknown' for a
    // severity-only start, but only the raw trigger is screened/derived — so a severity-only start
    // mines nothing (the logger gates derive + prompt on freeText.value, not the stored fallback).
    const storedTrigger = trigger?.trim() ? trigger : 'unknown';

    // The logger owns the ephemeral defer for this screened-record write.
    await this.logger.log({
      interaction,
      freeText: { value: trigger, derivePrefix: 'Tilt trigger' },
      persist: () =>
        this.tiltService.acceptOffer(interaction.user.id, {
          trigger: storedTrigger,
          severity: clampedSeverity,
        }),
      confirm: (technique) =>
        `Tilt session started. Trigger: ${storedTrigger} (Severity: ${clampedSeverity}/10)\n\nReset technique: ${technique}`,
    });
  }

  @Subcommand({ name: 'resolve', description: 'Resolve your current tilt session' })
  async resolve(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.handleResolve(interaction);
  }

  @Subcommand({ name: 'stats', description: 'View your tilt stats' })
  async stats(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.handleStats(interaction);
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
