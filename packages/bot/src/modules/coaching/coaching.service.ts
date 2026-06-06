import { prisma } from '@wabi/shared';
import { ClassifierService, type ClassifierResult } from './classifier.service';
import { CoachService } from './coach.service';
import { splitMessage } from './message-splitter';
import { Message, DMChannel } from 'discord.js';

export class CoachingService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly coach: CoachService,
  ) {}

  async handle(
    message: Message,
    onCrisis: () => Promise<void>,
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });

    if (!user || !user.consentAcceptedAt) {
      const setupUrl = process.env.DISCORD_REDIRECT_URI?.replace('/callback', '/onboard')
        || 'https://wabi.gg/onboard';
      await message.reply({
        content: `You'll need to finish setup before we can chat. Click here to get started: ${setupUrl}`,
      });
      return;
    }

    if (!user.hasActiveAccess) {
      const subscribeUrl = process.env.DISCORD_REDIRECT_URI?.replace('/callback', '/subscribe')
        || 'https://wabi.gg/subscribe';
      await message.reply({
        content: `Your trial has ended. Subscribe to continue chatting: ${subscribeUrl}`,
      });
      return;
    }

    if (message.channel instanceof DMChannel) {
      await message.channel.sendTyping();
    }

    const classification = await this.classifier.classify(message.content);

    if (classification === 'crisis') {
      await this.logEscalation(user.discordId, 'classifier');
      await onCrisis();
      return;
    }

    const reply = await this.coach.generate(message.content);
    if (!reply) {
      await message.reply("I'm not sure how to respond to that right now. Want to try again?");
      return;
    }

    const parts = splitMessage(reply);
    for (const part of parts) {
      await message.reply(part);
    }
  }

  private async logEscalation(userId: string, layer: string): Promise<void> {
    try {
      await prisma.escalationEvent.create({
        data: {
          userId: userId,
          layer,
        },
      });
    } catch {
      // Best-effort logging
    }
  }
}
