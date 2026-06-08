import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  BooleanOption,
  SlashCommandContext,
  Subcommand,
  createCommandGroupDecorator,
} from 'necord';
import { CommandInteraction, MessageFlags } from 'discord.js';
import { DataRightsService } from './data-rights.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export const DataCommandGroup = createCommandGroupDecorator({
  name: 'data',
  description: 'Manage your data',
  ...COMMAND_CONTEXTS,
});

export class DataDeleteDto {
  @BooleanOption({
    name: 'confirm',
    description: 'Confirm permanent deletion of all your data',
    required: false,
  })
  confirm?: boolean;
}

@Injectable()
@DataCommandGroup()
export class DataRightsController {
  constructor(private readonly dataRightsService: DataRightsService) {}

  @Subcommand({ name: 'export', description: 'Export all your data as JSON' })
  async export(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.handleExport(interaction);
  }

  @Subcommand({ name: 'delete', description: 'Permanently delete all your data' })
  async delete(
    @Context() [interaction]: SlashCommandContext,
    @Options() { confirm }: DataDeleteDto,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.handleDelete(interaction, confirm ?? false);
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

  private async handleDelete(interaction: CommandInteraction, confirm: boolean): Promise<void> {
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
