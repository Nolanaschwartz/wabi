import { Controller } from '@nestjs/common';
import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { DataRightsService } from './data-rights.service';

@Controller()
@SlashCommand({ name: 'data', description: 'Manage your data' })
export class DataRightsController {
  constructor(private readonly dataRightsService: DataRightsService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opts = (interaction as any).options;
    const subcommand = opts?.getSubcommand();

    if (subcommand === 'export') {
      await this.handleExport(interaction);
    } else if (subcommand === 'delete') {
      await this.handleDelete(interaction);
    } else {
      await interaction.editReply({
        content: "Usage: `/data export` or `/data delete confirm:true`",
      });
    }
  }

  private async handleExport(interaction: CommandInteraction): Promise<void> {
    try {
      const data = await this.dataRightsService.export(interaction.user.id);

      if (data.length > 2000) {
        const blob = Buffer.from(data);
        await interaction.editReply({
          content: 'Your data export is ready. Check your DMs.',
        });

        const dmChannel = await interaction.user.createDM();
        await dmChannel.send({
          content: 'Here\'s your data export:',
          files: [{
            attachment: blob,
            name: `wabi-export-${interaction.user.id}.json`,
          }],
        });
        return;
      }

      await interaction.editReply({
        content: `\`\`\`json\n${data}\n\`\`\``,
      });
    } catch {
      await interaction.editReply({
        content: 'Failed to export data. Please try again.',
      });
    }
  }

  private async handleDelete(interaction: CommandInteraction): Promise<void> {
    const opts = (interaction as any).options;
    const confirm = opts?.getBoolean('confirm') ?? false;

    if (!confirm) {
      await interaction.editReply({
        content: "To confirm deletion, run `/data delete confirm:true`. This will permanently delete all your data.",
      });
      return;
    }

    try {
      await this.dataRightsService.delete(interaction.user.id);

      await interaction.editReply({
        content: 'All your data has been deleted. You can start fresh anytime.',
      });
    } catch {
      await interaction.editReply({
        content: 'Failed to delete data. Please try again.',
      });
    }
  }
}
