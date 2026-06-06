import { Controller } from '@nestjs/common';
import { On } from 'necord';
import { Message } from 'discord.js';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { CrisisResourcesService } from '../crisis/crisis-resources.service';
import { CoachingService } from '../coaching/coaching.service';
import { prisma } from '@wabi/shared';

@Controller()
export class EchoController {
  constructor(
    private readonly crisisScreening: CrisisScreeningService,
    private readonly crisisResources: CrisisResourcesService,
    private readonly coaching: CoachingService,
  ) {}

  @On('messageCreate')
  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isDMBased()) return;

    if (this.crisisScreening.tripwire(message.content)) {
      await this.handleCrisis(message);
      return;
    }

    await this.coaching.handle(message, async () => this.handleCrisis(message));
  }

  private async handleCrisis(message: Message): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });
    const locale = user?.locale ?? 'en-US';
    const resources = this.crisisResources.resourcesFor(locale);

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
      // Best-effort logging
    }
  }
}
