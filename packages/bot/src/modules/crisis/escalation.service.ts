import { Injectable } from '@nestjs/common';
import { Message } from 'discord.js';
import { prisma } from '@wabi/shared';
import { CrisisResourcesService } from './crisis-resources.service';
import { CrisisAftermathService } from '../crisis-aftermath/crisis-aftermath.service';

export type EscalationLayer = 'tripwire' | 'classifier';

@Injectable()
export class EscalationService {
  constructor(
    private readonly crisisResources: CrisisResourcesService,
    private readonly crisisAftermath: CrisisAftermathService,
  ) {}

  // The single entry for a Crisis Escalation, from either detection layer (ADR-0006). Surfaces
  // resources, records exactly ONE content-free Escalation Event tagged with the layer that fired,
  // then hands off to the Crisis Aftermath (quarantine + one gentle follow-up, ADR-0010). Both the
  // tripwire path (EchoController) and the classifier path (CoachingService) call this exactly
  // once — so a classifier crisis can no longer also log a phantom 'tripwire' Event or
  // double-schedule the follow-up, the way the two hand-assembled paths used to.
  async escalate(message: Message, layer: EscalationLayer): Promise<void> {
    const userId = message.author.id;
    await this.surfaceResources(message);
    await this.logEvent(userId, layer);
    await this.crisisAftermath.onEscalation(userId);
  }

  private async surfaceResources(message: Message): Promise<void> {
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
  }

  private async logEvent(userId: string, layer: EscalationLayer): Promise<void> {
    try {
      await prisma.escalationEvent.create({
        data: { userId, layer },
      });
    } catch {
      // Best-effort, content-free logging (ADR-0010).
    }
  }
}
