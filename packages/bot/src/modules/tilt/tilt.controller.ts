import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { TiltService } from './tilt.service';

@SlashCommand({ name: 'tilt', description: 'Manage tilt sessions' })
export class TiltController {
  constructor(private readonly tiltService: TiltService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply();

    const opts = (interaction as any).options;
    const subcommand = opts?.getSubcommand();

    if (subcommand === 'start') {
      await this.handleStart(interaction);
    } else if (subcommand === 'resolve') {
      await this.handleResolve(interaction);
    } else if (subcommand === 'stats') {
      await this.handleStats(interaction);
    } else {
      await interaction.editReply({
        content: "Usage: `/tilt start trigger:... severity:1-10`, `/tilt resolve`, or `/tilt stats`",
      });
    }
  }

  private async handleStart(interaction: CommandInteraction): Promise<void> {
    const opts = (interaction as any).options;
    const trigger = opts?.getString('trigger') ?? 'unknown';
    const severity = Math.max(1, Math.min(10, opts?.getInteger('severity') ?? 5));

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
