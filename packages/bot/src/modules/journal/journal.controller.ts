import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { CommandInteraction } from 'discord.js';
import { JournalService } from './journal.service';
import { XpService } from '../xp/xp.service';

@Injectable()
@SlashCommand({ name: 'journal', description: 'Journal and reflect' })
export class JournalController {
  constructor(
    private readonly journalService: JournalService,
    private readonly xpService: XpService,
  ) {}

  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();

    const opts = (interaction as any).options;
    const subcommand = opts?.getSubcommand();

    if (subcommand === 'prompt') {
      await this.handlePrompt(interaction);
    } else if (subcommand === 'write') {
      await this.handleWrite(interaction);
    } else {
      await interaction.editReply({
        content: "Usage: `/journal prompt` or `/journal write content:...`",
      });
    }
  }

  private async handlePrompt(interaction: CommandInteraction): Promise<void> {
    const prompt = await this.journalService.prompt();
    await interaction.editReply({
      content: `Here's a prompt to get you thinking:\n"${prompt}"`,
    });
  }

  private async handleWrite(interaction: CommandInteraction): Promise<void> {
    const opts = (interaction as any).options;
    const content = opts?.getString('content') ?? '';

    if (content.length < 10) {
      await interaction.editReply({
        content: "That's a bit short. Try writing a few sentences about how you're feeling.",
      });
      return;
    }

    const result = await this.journalService.write(interaction.user.id, content);

    if (result.crisis) {
      await interaction.editReply({
        content: "I'm hearing that things are really tough right now. If you're in crisis, please reach out to someone who can help. You matter.",
      });
      return;
    }

    await this.xpService.award(interaction.user.id, 10, 'journal');

    await interaction.editReply({
      content: `Entry saved. ${result.reflection} (+10 XP)`,
    });
  }
}
