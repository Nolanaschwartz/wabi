import { prisma } from '@wabi/shared';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { splitMessage } from './message-splitter';
import { Message, DMChannel } from 'discord.js';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../billing/access-resolver';
import { MemoryStoreService } from '../memory/memory-store.service';

export class CoachingService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly coach: CoachService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly strategyRetrieval: StrategyRetrievalService,
    private readonly burstCoalescer: BurstCoalescer,
    private readonly langfuseTracer: LangfuseTracer,
    private readonly accessResolver: AccessResolver,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  async handle(
    message: Message,
    onCrisis: () => Promise<void>,
  ): Promise<void> {
    const userId = message.author.id;
    const traceId = crypto.randomUUID();

    const user = await prisma.user.findUnique({
      where: { discordId: userId },
    });

    if (!user || !user.consentAcceptedAt) {
      const setupUrl = process.env.DISCORD_REDIRECT_URI?.replace('/callback', '/onboard')
        || 'https://wabi.gg/onboard';
      await message.reply({
        content: `You'll need to finish setup before we can chat. Click here to get started: ${setupUrl}`,
      });
      return;
    }

    const access = await this.accessResolver.resolve(userId);
    if (!access.hasActiveAccess) {
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

    const batch = await this.burstCoalescer.coalesce(userId, message.content);
    if (batch === '__canceled__') {
      return;
    }

    const [classification, strategies] = await Promise.all([
      this.classifier.classify(batch),
      this.strategyRetrieval.search(batch).catch(() => []),
    ]);

    if (classification === 'crisis') {
      this.burstCoalescer.cancel(userId);
      await this.sessionBuffer.clearAndQuarantine(userId);
      await this.logEscalation(userId, 'classifier');
      this.langfuseTracer.trace(traceId, 'classify', batch, 'crisis', { isCrisis: true });
      await onCrisis();
      return;
    }

    this.langfuseTracer.trace(traceId, 'classify', batch, 'safe');

    const context = await this.buildContext(userId, batch, strategies);

    const coachStart = Date.now();
    const reply = await this.coach.generate(context);
    const coachLatency = Date.now() - coachStart;

    if (!reply) {
      await message.reply("I'm not sure how to respond to that right now. Want to try again?");
      return;
    }

    await this.sessionBuffer.append(userId, 'user', message.content);
    await this.sessionBuffer.append(userId, 'assistant', reply);

    await this.memoryStore.deriveAndStore(userId, `${message.content} | ${reply}`);

    this.langfuseTracer.trace(traceId, 'coach', context, reply, { latencyMs: coachLatency });

    const parts = splitMessage(reply);
    for (const part of parts) {
      await message.reply(part);
    }
  }

  cancelPending(userId: string): void {
    this.burstCoalescer.cancel(userId);
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
