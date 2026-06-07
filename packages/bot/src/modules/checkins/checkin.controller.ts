import { Injectable } from '@nestjs/common';
import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { CheckInService } from './checkin.service';
import { CHECK_IN_CADENCES, CheckInCadence } from './checkin-timing';

@Injectable()
@SlashCommand({ name: 'checkins', description: 'Manage your check-in preferences' })
export class CheckInController {
  constructor(private readonly checkInService: CheckInService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opts = (interaction as any).options;
    const enabled = opts?.getBoolean('enabled') ?? undefined;
    const cadence = opts?.getString('cadence') ?? undefined;
    const timezone = opts?.getString('timezone') ?? undefined;

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
