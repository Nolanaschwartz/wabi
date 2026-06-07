import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ClassifierService } from './classifier.service';
import { CoachService } from './coach.service';
import { splitMessage } from './message-splitter';
import { Message, DMChannel } from 'discord.js';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../billing/access-resolver';
import { MemoryStoreService } from '../memory/memory-store.service';
import { CrisisAftermathService } from '../crisis-aftermath/crisis-aftermath.service';
import { StreaksService } from '../streaks/streaks.service';
import { TiltService } from '../tilt/tilt.service';
import { setupLinkMessage } from '../../lib/setup-link';

@Injectable()
export class CoachingService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly coach: CoachService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly coachingSession: CoachingSessionService,
    private readonly strategyRetrieval: StrategyRetrievalService,
    private readonly burstCoalescer: BurstCoalescer,
    private readonly langfuseTracer: LangfuseTracer,
    private readonly accessResolver: AccessResolver,
    private readonly memoryStore: MemoryStoreService,
    private readonly crisisAftermath: CrisisAftermathService,
    private readonly streaks: StreaksService,
    private readonly tilt: TiltService,
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

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://wabi.gg';

    if (!user || !user.consentAcceptedAt) {
      await message.reply({
        content: setupLinkMessage(baseUrl),
      });
      return;
    }

    const access = await this.accessResolver.resolve(userId);
    if (!access.hasActiveAccess) {
      // The dashboard surfaces the Subscribe control (which starts Stripe checkout). Pointing at
      // the bare landing page was a dead end — issue #28.
      const subscribeUrl = `${baseUrl}/dashboard`;
      await message.reply({
        content: `Your trial has ended. Subscribe to continue chatting: ${subscribeUrl}`,
      });
      return;
    }

    // Tilt offer response: if we previously offered a Tilt Session, this turn may be
    // the user's accept/decline. Handle it before normal coaching. (#31 / #12)
    const pendingTrigger = this.tilt.getPendingOffer(userId);
    if (pendingTrigger) {
      const intent = message.content.trim().toLowerCase();
      if (intent === 'accept' || intent.startsWith('accept')) {
        const technique = await this.tilt.acceptPendingOffer(userId);
        await message.reply(`Tilt session started. Reset technique: ${technique}`);
        return;
      }
      if (intent === 'decline' || intent.startsWith('decline')) {
        this.tilt.clearPendingOffer(userId);
        await message.reply(this.tilt.createOffer(pendingTrigger).declineMessage);
        return;
      }
      // Neither accept nor decline — let the offer lapse (TTL) and continue coaching,
      // suppressing a duplicate offer this turn (see the detection block below).
    }

    if (message.channel instanceof DMChannel) {
      await message.channel.sendTyping();
    }

    await this.coachingSession.touch(userId);

    const batch = await this.burstCoalescer.coalesce(userId, message.content);
    if (!batch || batch === '__canceled__') {
      return;
    }

    const [classification, strategies] = await Promise.all([
      this.classifier.classify(batch),
      this.strategyRetrieval.search(batch).catch(() => []),
    ]);

    if (classification === 'crisis') {
      this.burstCoalescer.cancel(userId);
      await this.sessionBuffer.clearAndQuarantine(userId);
      await this.coachingSession.quarantine(userId);
      await this.logEscalation(userId, 'classifier');
      this.langfuseTracer.trace(traceId, 'classify', batch, 'crisis', { isCrisis: true });
      await this.crisisAftermath.onEscalation(userId);
      await onCrisis();
      return;
    }

    this.langfuseTracer.trace(traceId, 'classify', batch, 'safe');

    const inAftermath = await this.crisisAftermath.isQuarantined(userId);

    // Detected gameplay frustration → offer a Tilt Session (user stays in control),
    // never auto-start one. Suppressed during crisis aftermath (#05) and when an offer
    // is already pending this turn. (#31 / #12)
    if (!inAftermath && !pendingTrigger && this.tilt.isTiltLanguage(batch)) {
      const trigger = this.tilt.detectTrigger(batch) ?? 'tilt';
      this.tilt.setPendingOffer(userId, trigger);
      await message.reply(this.tilt.createOffer(trigger).acceptMessage);
      return;
    }

    const context = await this.buildContext(userId, batch, strategies, inAftermath);

    const coachStart = Date.now();
    const reply = await this.coach.generate(context, inAftermath);
    const coachLatency = Date.now() - coachStart;

    if (!reply) {
      await message.reply("I'm not sure how to respond to that right now. Want to try again?");
      return;
    }

    await this.sessionBuffer.append(userId, 'user', message.content);
    await this.sessionBuffer.append(userId, 'assistant', reply);

    const streakResult = await this.streaks.checkAndAward(userId, user.timezone ?? 'UTC').catch(() => null);

    await this.memoryStore.deriveAndStore(userId, `${message.content} | ${reply}`);

    this.langfuseTracer.trace(traceId, 'coach', context, reply, { latencyMs: coachLatency });

    const parts = splitMessage(reply);
    for (const part of parts) {
      await message.reply(part);
    }
    if (streakResult && streakResult.message) {
      await message.reply(streakResult.message);
    }
  }

  cancelPending(userId: string): void {
    this.burstCoalescer.cancel(userId);
  }

  private async buildContext(
    userId: string,
    currentMessage: string,
    strategies: Array<{ content: string; evidence: string }>,
    inAftermath: boolean = false,
  ): Promise<string> {
    const session = await this.sessionBuffer.getContext(userId);
    const turnHistory = session?.turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n')
      .trim();

    // Read-back: surface what we've learned about this person (self-hosted Memory).
    const memories = await this.memoryStore.search(userId, currentMessage);
    const memoryContext = memories.length > 0
      ? `\nWhat you remember about this person:\n${memories
          .slice(0, 5)
          .map((m) => `- ${m.content}`)
          .join('\n')}`
      : '';

    const strategyContext = strategies.length > 0
      ? `\nRelevant strategies:\n${strategies.map((s) => `- ${s.content} (${s.evidence})`).join('\n')}`
      : '';

    let context = `Conversation history:\n${turnHistory || 'No prior turns'}`;
    context += memoryContext;
    context += strategyContext;
    if (inAftermath) {
      context += '\n\nIMPORTANT: The user recently experienced a crisis. Be gentle and supportive. Avoid cheerful or energetic tone. Re-screen for safety.';
    }
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
