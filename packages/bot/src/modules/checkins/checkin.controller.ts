import { Injectable } from '@nestjs/common';
import { SlashCommand } from 'necord';
import { CommandInteraction } from 'discord.js';
import { CheckInService } from './checkin.service';

@Injectable()
@SlashCommand({ name: 'checkins', description: 'Manage your check-in preferences' })
export class CheckInController {
  constructor(private readonly checkInService: CheckInService) {}

  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opts = (interaction as any).options;
    const enabled = opts?.getBoolean('enabled');

    if (enabled === undefined) {
      await interaction.editReply({
        content: 'Usage: `/checkins enabled:true` or `/checkins enabled:false`',
      });
      return;
    }

    try {
      await this.checkInService.toggleCheckIn(interaction.user.id, enabled);

      await interaction.editReply({
        content: enabled
          ? 'Check-ins enabled. I\'ll check in on you periodically.'
          : 'Check-ins disabled. Take care of yourself!',
      });
    } catch {
      await interaction.editReply({
        content: 'Failed to update check-in preferences.',
      });
    }
  }
}
