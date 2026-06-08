import { Injectable } from '@nestjs/common';
import {
  Context,
  Options,
  BooleanOption,
  StringOption,
  SlashCommand,
  SlashCommandContext,
} from 'necord';
import { MessageFlags } from 'discord.js';
import { CheckInService } from './checkin.service';
import { CHECK_IN_CADENCES, CheckInCadence } from './checkin-timing';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export class CheckinDto {
  @BooleanOption({
    name: 'enabled',
    description: 'Turn check-ins on or off',
    required: false,
  })
  enabled?: boolean;

  @StringOption({
    name: 'cadence',
    description: 'How often I check in',
    required: false,
    choices: CHECK_IN_CADENCES.map((c) => ({ name: c, value: c })),
  })
  cadence?: string;

  @StringOption({
    name: 'timezone',
    description: 'Your IANA timezone, e.g. America/New_York',
    required: false,
  })
  timezone?: string;
}

@Injectable()
export class CheckInController {
  constructor(private readonly checkInService: CheckInService) {}

  @SlashCommand({ name: 'checkins', description: 'Manage your check-in preferences', ...COMMAND_CONTEXTS })
  async execute(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: CheckinDto,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const enabled = options.enabled ?? undefined;
    const cadence = options.cadence ?? undefined;
    const timezone = options.timezone ?? undefined;

    if (enabled === undefined && cadence === undefined && timezone === undefined) {
      await interaction.editReply({
        content:
          'Usage: `/checkins enabled:true|false cadence:daily|every-other|weekly timezone:Area/City`',
      });
      return;
    }

    if (cadence !== undefined && !CHECK_IN_CADENCES.includes(cadence as CheckInCadence)) {
      await interaction.editReply({
        content: `Invalid cadence. Choose one of: ${CHECK_IN_CADENCES.join(', ')}.`,
      });
      return;
    }

    try {
      const lines: string[] = [];

      if (enabled !== undefined) {
        await this.checkInService.toggleCheckIn(interaction.user.id, enabled);
        lines.push(
          enabled
            ? "Check-ins enabled. I'll check in on you periodically."
            : 'Check-ins disabled. Take care of yourself!',
        );
      }

      if (cadence !== undefined) {
        await this.checkInService.setCadence(interaction.user.id, cadence as CheckInCadence);
        lines.push(`Cadence set to **${cadence}**.`);
      }

      if (timezone !== undefined) {
        const effective = await this.checkInService.setTimezone(interaction.user.id, timezone);
        lines.push(
          effective === timezone
            ? `Timezone set to **${effective}**.`
            : `"${timezone}" isn't a valid timezone — defaulted to **${effective}**.`,
        );
      }

      await interaction.editReply({ content: lines.join('\n') });
    } catch {
      await interaction.editReply({
        content: 'Failed to update check-in preferences.',
      });
    }
  }
}
