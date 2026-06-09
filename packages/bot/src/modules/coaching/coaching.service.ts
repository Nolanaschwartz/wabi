import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ClassifierService } from '../crisis/classifier.service';
import { CoachService } from './coach.service';
import { buildCoachPrompt } from './coach-prompt';
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
import { EscalationService } from '../crisis/escalation.service';
import { HabitEngagementService } from '../habit-engagement/habit-engagement.service';
import { TiltService } from '../tilt/tilt.service';
import { setupLinkMessage } from '../../lib/setup-link';

@Injectable()
export class CoachingService {
  private readonly logger = new Logger(CoachingService.name);

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
    private readonly escalation: EscalationService,
    private readonly habitEngagement: HabitEngagementService,
    private readonly tilt: TiltService,
  ) {}

  async handle(message: Message): Promise<void> {
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

    // Resolve access now, but do NOT gate on it yet. The crisis classifier is the safety floor and
    // must run for every consented user — active OR lapsed (ADR-0011/0021): a paraphrased crisis
    // with no tripwire keyword is only caught by the LLM, and a lapsed at-risk user is exactly who
    // must not be missed. Coaching itself is gated AFTER classification, below.
    const access = await this.accessResolver.resolve(userId);

    // Tilt offer response: if we previously offered a Tilt Session, this turn may be the user's
    // accept/decline. The whole state machine lives in TiltService now; here we just route its
    // reply. accepted/declined end the turn; none/ignored fall through to coaching. (#31 / #12)
    const offerResponse = await this.tilt.respondToPendingOffer(userId, message.content);
    if (offerResponse.kind === 'accepted' || offerResponse.kind === 'declined') {
      await message.reply(offerResponse.reply);
      return;
    }

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    const dmChannel = message.channel instanceof DMChannel ? message.channel : null;
    if (dmChannel) {
      await dmChannel.sendTyping();
      typingInterval = setInterval(() => dmChannel.sendTyping(), 7000);
    }

    try {
      await this.coachingSession.touch(userId);

      const coalesced = await this.burstCoalescer.coalesce(userId, message.content);
      if (coalesced.kind === 'coalesced' || coalesced.kind === 'canceled') {
        // Folded into an in-flight burst, or the turn was canceled — nothing to coach.
        return;
      }
      if (coalesced.kind === 'rate_limited') {
        // Hourly ceiling tripped: send the caring reply and stop. It is NOT a batch — the old
        // sentinel let it fall through and get re-classified/re-coached, so the limit did nothing.
        await message.reply(coalesced.text);
        return;
      }
      const batch = coalesced.text;

      const [classification, strategies] = await Promise.all([
        this.classifier.classify(batch),
        this.strategyRetrieval.search(batch).catch(() => []),
      ]);

      if (classification === 'crisis') {
        this.burstCoalescer.cancel(userId);
        this.langfuseTracer.trace(traceId, 'classify', batch, 'crisis', { isCrisis: true });
        // One seam for the whole crisis response: resources + ONE Escalation Event ('classifier')
        // + quarantine + ONE follow-up. Escalation returns the renderable payload; we send it on the
        // DM channel. No more hand-assembling the sequence here and again on the tripwire path.
        // (ADR-0006/0010/0028.)
        const response = await this.escalation.escalate(userId, 'classifier');
        await message.reply(response);
        return;
      }

      this.langfuseTracer.trace(traceId, 'classify', batch, 'safe');

      // Safety has run (tripwire + classifier). Coaching is the paid surface: a lapsed user gets a
      // resubscribe prompt HERE — after crisis screening, never instead of it. (ADR-0011: classifier
      // = consented; coach + store = active access. Dashboard carries the Subscribe control, #28.)
      if (!access.hasActiveAccess) {
        const subscribeUrl = `${baseUrl}/dashboard`;
        await message.reply({
          content: `Your trial has ended. Subscribe to continue chatting: ${subscribeUrl}`,
        });
        return;
      }

      const inAftermath = await this.crisisAftermath.isQuarantined(userId);

      // Detected gameplay frustration → offer a Tilt Session (user stays in control), never
      // auto-start one. Suppressed during crisis aftermath (#05); maybeOffer self-suppresses when an
      // offer is already pending (the lapsing 'ignored' case above). (#31 / #12)
      if (!inAftermath) {
        const offerMessage = this.tilt.maybeOffer(userId, batch);
        if (offerMessage) {
          await message.reply(offerMessage);
          return;
        }
      }

      // Gather context (I/O), then hand it to the pure prompt assembler. CoachingService never
      // shapes the prompt string itself — buildCoachPrompt owns persona + layout + read-back labels.
      const session = await this.sessionBuffer.getContext(userId);
      const memories = await this.memoryStore.search(userId, batch);
      const { system, prompt } = buildCoachPrompt({
        currentMessage: batch,
        turns: session?.turns ?? [],
        memories,
        strategies,
        inAftermath,
      });

      const coachStart = Date.now();
      const reply = await this.coach.generate(system, prompt);
      const coachLatency = Date.now() - coachStart;

    if (!reply) {
        this.logger.warn('coach returned empty, sending fallback', { userId });
        await message.reply("I'm not sure how to respond to that right now. Want to try again?");
        return;
      }

      await this.sessionBuffer.append(userId, 'user', message.content);
      await this.sessionBuffer.append(userId, 'assistant', reply);

      const streakResult = await this.habitEngagement.record(userId, 'coaching', user.timezone ?? 'UTC').catch(() => null);

      this.langfuseTracer.trace(traceId, 'coach', prompt, reply, { latencyMs: coachLatency });

      // Send the reply BEFORE persisting long-term memory. deriveAndStore runs mem0's hybrid
      // vector+graph extraction (~20s+ since ADR-0025), which must never delay the user-visible reply.
      const parts = splitMessage(reply);
      for (const part of parts) {
        await message.reply(part);
      }
      if (streakResult && streakResult.message) {
        await message.reply(streakResult.message);
      }

      // Fire-and-forget: persistence failures are already logged inside deriveAndStore, and memory is
      // not needed to answer this turn. Awaiting it here previously starved the reply.
      void this.memoryStore.deriveAndStore(userId, `${message.content} | ${reply}`);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  cancelPending(userId: string): void {
    this.burstCoalescer.cancel(userId);
  }
}
