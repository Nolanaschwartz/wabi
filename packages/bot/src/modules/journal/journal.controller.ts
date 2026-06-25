import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  StringOption,
  SlashCommandContext,
  Subcommand,
  createCommandGroupDecorator,
} from 'necord';
import { CommandInteraction, MessageFlags } from 'discord.js';
import { JournalService } from './journal.service';
import { requireScreenedText } from '../crisis/screened';
import { InnerStateLoggerService } from '../inner-state-logger/inner-state-logger.service';
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
    private readonly logger: InnerStateLoggerService,
  ) {}

  @Subcommand({ name: 'prompt', description: 'Get a reflective journaling prompt' })
  async prompt(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.handlePrompt(interaction);
  }

  @Subcommand({ name: 'write', description: 'Write a journal entry' })
  async write(
    @Context() [interaction]: SlashCommandContext,
    @Options() { content }: JournalWriteDto,
  ): Promise<void> {
    // A journal entry is always free-text inner state, so it always screens, derives (prefixed), and
    // is a first-use consent-prompt candidate. The too-short check is a pre-screen reject (no
    // classifier call); the logger renders it on the ephemeral reply and owns the defer.
    await this.logger.log({
      interaction,
      freeText: { value: content, derivePrefix: 'Journal' },
      validate: () =>
        content.length < 10
          ? "That's a bit short. Try writing a few sentences about how you're feeling."
          : null,
      // A journal entry is always free text (the <10 reject guarantees it), so the proof is the minable
      // arm — narrow and hand the `ScreenedText` straight to the writer (ADR-0031).
      persist: (screened) =>
        this.journalService.write(interaction.user.id, requireScreenedText(screened)),
      confirm: ({ reflection, xpAwarded }) => `Entry saved. ${reflection} (+${xpAwarded} XP)`,
    });
  }

  private async handlePrompt(interaction: CommandInteraction): Promise<void> {
    const prompt = await this.journalService.prompt();
    await interaction.editReply({
      content: `Here's a prompt to get you thinking:\n"${prompt}"`,
    });
  }
}
