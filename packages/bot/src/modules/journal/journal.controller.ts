import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  StringOption,
  SlashCommandContext,
  Subcommand,
  createCommandGroupDecorator,
} from 'necord';
import { CommandInteraction } from 'discord.js';
import { JournalService } from './journal.service';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export const JournalCommandGroup = createCommandGroupDecorator({
  name: 'journal',
  description: 'Journal and reflect',
  ...COMMAND_CONTEXTS,
});

export class JournalWriteDto {
  @StringOption({
    name: 'content',
    description: 'Write a few sentences about how you feel',
    required: true,
  })
  content!: string;
}

@Injectable()
@JournalCommandGroup()
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  @Subcommand({ name: 'prompt', description: 'Get a reflective journaling prompt' })
  async prompt(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply();
    await this.handlePrompt(interaction);
  }

  @Subcommand({ name: 'write', description: 'Write a journal entry' })
  async write(
    @Context() [interaction]: SlashCommandContext,
    @Options() { content }: JournalWriteDto,
  ): Promise<void> {
    await interaction.deferReply();
    await this.handleWrite(interaction, content);
  }

  private async handlePrompt(interaction: CommandInteraction): Promise<void> {
    const prompt = await this.journalService.prompt();
    await interaction.editReply({
      content: `Here's a prompt to get you thinking:\n"${prompt}"`,
    });
  }

  private async handleWrite(interaction: CommandInteraction, content: string): Promise<void> {
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

    await interaction.editReply({
      content: `Entry saved. ${result.reflection} (+${result.xpAwarded} XP)`,
    });
  }
}
