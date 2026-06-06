import { prisma } from '@wabi/shared';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { splitMessage } from './message-splitter';
import { Message, DMChannel } from 'discord.js';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';

export class CoachingService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly coach: CoachService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly strategyRetrieval: StrategyRetrievalService,
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
      await this.sessionBuffer.clearAndQuarantine(user.discordId);
      await this.logEscalation(user.discordId, 'classifier');
      await onCrisis();
      return;
    }

    const strategies = await this.strategyRetrieval.search(message.content);
    const context = await this.buildContext(
      user.discordId,
      message.content,
      strategies,
    );

    const reply = await this.coach.generate(context);
    if (!reply) {
      await message.reply("I'm not sure how to respond to that right now. Want to try again?");
      return;
    }

    await this.sessionBuffer.append(user.discordId, 'user', message.content);
    await this.sessionBuffer.append(user.discordId, 'assistant', reply);

    const parts = splitMessage(reply);
    for (const part of parts) {
      await message.reply(part);
    }
  }

  private async buildContext(
    userId: string,
    currentMessage: string,
    strategies: Array<{ content: string; evidence: string }>,
  ): Promise<string> {
    const session = await this.sessionBuffer.getContext(userId);
    const turnHistory = session?.turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n')
      .trim();

    const strategyContext = strategies.length > 0
      ? `\nRelevant strategies:\n${strategies.map((s) => `- ${s.content} (${s.evidence})`).join('\n')}`
      : '';

    let context = `Conversation history:\n${turnHistory || 'No prior turns'}`;
    context += strategyContext;
    context += `\n\nCurrent message: ${currentMessage}`;

    return context;
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
