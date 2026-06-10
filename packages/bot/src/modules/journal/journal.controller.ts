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
import { InnerStateConsentService } from '../memory/inner-state-consent.service';
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
  constructor(
    private readonly journalService: JournalService,
    private readonly consent: InnerStateConsentService,
  ) {}

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
      // Real locale Crisis Resources surfaced by screening (ADR-0028) — not a hand-rolled platitude.
      await interaction.editReply(result.response);
      return;
    }

    const base = `Entry saved. ${result.value.reflection} (+${result.value.xpAwarded} XP)`;
    // A journal entry is always free-text inner state, so it's a first-use prompt candidate. The
    // consent module decides whether to actually show it (at most once across all fields, ADR-0029).
    const prompt = await this.consent.prepareFirstUsePrompt(interaction.user.id);
    await interaction.editReply({
      content: prompt ? `${base}\n\n${prompt.content}` : base,
      components: prompt ? prompt.components : [],
    });
  }
}
