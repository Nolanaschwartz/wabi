import { Injectable, Logger } from '@nestjs/common';
import { ClassifierService, type ClassifierContext } from '../crisis/classifier.service';
import { Message, DMChannel } from 'discord.js';
import { SessionBufferService, type SessionContext } from '../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../billing/access-resolver';
import { CrisisAftermathService } from '../crisis-aftermath/crisis-aftermath.service';
import { EscalationService } from '../crisis/escalation.service';
import { TiltService } from '../tilt/tilt.service';
import { UserService } from '../user/user.service';
import { DmRouterService } from './dm-router.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { JournalSessionService } from '../journal/journal-session.service';
import { setupLinkMessage } from '../../lib/setup-link';

@Injectable()
export class CoachingService {
  private readonly logger = new Logger(CoachingService.name);

  constructor(
    private readonly classifier: ClassifierService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly coachingSession: CoachingSessionService,
    private readonly strategyRetrieval: StrategyRetrievalService,
    private readonly burstCoalescer: BurstCoalescer,
    private readonly langfuseTracer: LangfuseTracer,
    private readonly accessResolver: AccessResolver,
    private readonly crisisAftermath: CrisisAftermathService,
    private readonly escalation: EscalationService,
    private readonly tilt: TiltService,
    private readonly userService: UserService,
    private readonly dmRouter: DmRouterService,
    private readonly intentRouter: IntentRouterService,
    private readonly journalSession: JournalSessionService,
  ) {}

  async handle(message: Message): Promise<void> {
    const userId = message.author.id;
    const traceId = crypto.randomUUID();

    const user = await this.userService.findByDiscordId(userId);

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

      // Disambiguating context for the safety classifier. The classifier is otherwise context-blind,
      // and its fail-closed bias tips bare ambiguous phrases ("it's not helping", said about a tilt-
      // reset technique) to 'crisis'. We fetch the live session once here and reuse it for the coach
      // prompt below. Gathering context must NEVER block classification: any failure degrades to a
      // context-free classify (the prior behaviour), with the tripwire floor still upstream. (ADR-0021.)
      const session = await this.sessionBuffer.getContext(userId).catch(() => null);
      const classifierContext = await this.buildClassifierContext(userId, session);

      // Is a two-turn journal capture armed? Cheap, fail-soft Redis read. When set, THIS turn is the
      // entry, so the intent-router LLM call is pointless — skip it (the dispatch is predetermined).
      const pendingJournal = await this.journalSession.isPending(userId);

      // The intent router runs IN this block — parallel with the crisis classifier and strategy
      // search, so dispatch intent costs no added serial latency. It is fail-soft (coach/0 on any
      // error) and is NEVER consulted on a crisis turn: a crisis short-circuits below and the intent
      // is discarded. (ADR-0021: safety is the floor; routing is downstream of it.) When a journal
      // capture is pending we substitute a synthetic verdict and skip the LLM entirely.
      const [classification, strategies, intent] = await Promise.all([
        this.classifier.classify(batch, classifierContext),
        this.strategyRetrieval.search(batch).catch(() => []),
        pendingJournal
          ? Promise.resolve({ intent: 'journal' as const, confidence: 1 })
          : this.intentRouter.route(batch, { recentTurns: session?.turns }),
      ]);

      if (classification === 'crisis') {
        this.burstCoalescer.cancel(userId);
        // Crisis on the capture turn: drop the pending marker so the crisis text never reaches
        // JournalService.write and a later DM routes fresh. (Quarantine clears buffers too, but the
        // pending marker is ours to clear.) Best-effort — a lingering marker would expire on its TTL.
        if (pendingJournal) await this.journalSession.clear(userId);
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

      // Observe-only: record the router's verdict on every safe turn so the dispatch threshold (θ) can
      // be tuned against real traffic before any intent actually changes behaviour (Slice A2).
      this.langfuseTracer.trace(traceId, 'intent', batch, intent.intent, {
        confidence: intent.confidence,
      });

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

      // The turn has cleared every gate: consented user, screened safe, active access, no tilt offer
      // outstanding. Hand it to the router, which dispatches to the right handler (today: coach only).
      // The crisis-safety floor does NOT live in the router — it is always upstream of this call.
      await this.dmRouter.route(
        {
          message,
          userId,
          batch,
          session,
          strategies,
          inAftermath,
          timezone: user.timezone ?? 'UTC',
          traceId,
        },
        intent,
        pendingJournal,
      );
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  /**
   * Assemble disambiguation context for the crisis classifier. Always returns an object so EVERY
   * screening call carries context (empty when the message is cold) — the classifier wraps it in a
   * uniform envelope either way. Every source is best-effort: a failed tilt lookup must not stop the
   * classifier running, so it degrades to `inTiltSession: false` rather than throwing. (ADR-0021.)
   */
  private async buildClassifierContext(
    userId: string,
    session: SessionContext | null,
  ): Promise<ClassifierContext> {
    let inTiltSession = false;
    try {
      inTiltSession = await this.tilt.hasActiveSession(userId);
    } catch {
      inTiltSession = false;
    }

    const recentTurns = session?.turns?.length ? session.turns : undefined;

    return { inTiltSession, recentTurns };
  }

  cancelPending(userId: string): void {
    this.burstCoalescer.cancel(userId);
  }
}
