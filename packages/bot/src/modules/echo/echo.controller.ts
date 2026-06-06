import { On } from 'necord';
import { Message } from 'discord.js';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { CrisisResourcesService } from '../crisis/crisis-resources.service';
import { prisma } from '@wabi/shared';

@On('messageCreate')
export class EchoController {
  constructor(
    private readonly crisisScreening: CrisisScreeningService,
    private readonly crisisResources: CrisisResourcesService,
  ) {}

  async handleEcho(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isDMBased()) return;

    if (this.crisisScreening.tripwire(message.content)) {
      await this.handleCrisis(message);
      return;
    }

    await message.reply(`Echo: ${message.content}`);
  }

  private async handleCrisis(message: Message): Promise<void> {
    const resources = this.crisisResources.resourcesFor('en-US');

    const resourceLines = resources.resources.map((r) => {
      if (r.type === 'web') return `• ${r.name}: ${r.url}`;
      if (r.type === 'info') return `• ${r.name}`;
      return `• ${r.name}: ${r.phone}`;
    });

    const embed = {
      color: 0x000000,
      title: '🚨 You matter',
      description:
        "If you're in crisis, real people are here to help. Please reach out:",
      fields: [
        {
          name: 'Resources',
          value: resourceLines.join('\n'),
          inline: false,
        },
      ],
      footer: { text: 'These numbers are free and confidential' },
    };

    await message.reply({ embeds: [embed] });

    try {
      await prisma.escalationEvent.create({
        data: {
          userId: message.author.id,
          layer: 'tripwire',
        },
      });
    } catch {
      // Escalation event logging may fail if Postgres is down — that's OK.
      // The safety floor still worked: resources were surfaced.
    }
  }
}
