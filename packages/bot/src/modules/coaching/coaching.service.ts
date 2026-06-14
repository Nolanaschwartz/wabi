import { Injectable } from '@nestjs/common';
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
import { setupLinkMessage } from '../../lib/setup-link';
import { JsonLogger, withTraceId } from '../../lib/json-logger';

// Resolve a promise while recording how long it took, so each parallel op can report its own span
// latency. Failure handling stays with the caller (e.g. strategy search catches before measure).
async function measure<T>(p: Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  const value = await p;
  return { value, latencyMs: Date.now() - start };
}

@Injectable()
export class CoachingService {
  private readonly logger = new JsonLogger(CoachingService.name);

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
  ) {}

  async handle(message: Message): Promise<void> {
    const userId = message.author.id;
    const traceId = crypto.randomUUID();

    return withTraceId(traceId, async () => {
      const start = Date.now();

      this.logger.log('message received', { userId, traceId });

      const user = await this.userService.findByDiscordId(userId);

      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://wabi.gg';

      if (!user || !user.consentAcceptedAt) {
        this.logger.log('user no consent', { userId });
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
        this.logger.log('tilt offer response', { userId, kind: offerResponse.kind });
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
          this.logger.log('burst coalesced/canceled', { userId, kind: coalesced.kind });
          return;
        }
        if (coalesced.kind === 'rate_limited') {
          this.logger.log('rate limited', { userId });
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

        // The router's routing decision runs IN this block — parallel with the crisis classifier and
        // strategy search, so it costs no added serial latency. prepare() is side-effect-free and the
        // whole routing decision (pending-capture check, intent classifier, θ, inline extraction) lives
        // behind it; the dispatch is deferred to the safe path below. The crisis floor stays upstream of
        // the router: a crisis short-circuits here and the plan is discarded. (ADR-0021: safety is the
        // floor; routing is downstream of it.)
        // Time each parallel op independently so its span records its own latency — an operator can
        // then see whether classification, retrieval, or routing was the slow part of the turn.
        const [classifyResult, strategyResult, decisionResult] = await Promise.all([
          measure(this.classifier.classify(batch, classifierContext)),
          measure(this.strategyRetrieval.search(batch).catch(() => [])),
          measure(this.dmRouter.prepare(userId, batch, { recentTurns: session?.turns })),
        ]);
        const classification = classifyResult.value;
        const strategies = strategyResult.value;
        const decision = decisionResult.value;

        this.logger.log('pipeline parallel complete', {
          userId,
          classification,
          strategyCount: strategies.length,
          intent: decision.verdict.intent,
          confidence: decision.verdict.confidence,
        });

        if (classification === 'crisis') {
          this.burstCoalescer.cancel(userId);
          // Crisis on a capture turn (journal or mood holds the floor): drop the spoke floor so the
          // crisis text never reaches a spoke writer and a later DM routes fresh. (Quarantine clears
          // buffers too, but the floor is the router's to clear.) Best-effort — a marker expires on TTL.
          // Read the router's own `isCapture` fact, not its internal plan shape (ADR-0030).
          if (decision.isCapture) {
            await this.dmRouter.clearPending(userId);
          }
          this.langfuseTracer.span({ traceId, span: 'classify', input: batch, output: 'crisis', isCrisis: true });
          // One seam for the whole crisis response: resources + ONE Escalation Event ('classifier')
          // + quarantine + ONE follow-up. Escalation returns the renderable payload; we send it on the
          // DM channel. No more hand-assembling the sequence here and again on the tripwire path.
          // (ADR-0006/0010/0028.)
          const response = await this.escalation.escalate(userId, 'classifier', 'conversation');
          await message.reply(response);
          this.logger.log('pipeline complete', { userId, stage: 'crisis', durationMs: Date.now() - start });
          return;
        }

        this.langfuseTracer.span({
          traceId,
          span: 'classify',
          input: batch,
          output: 'safe',
          latencyMs: classifyResult.latencyMs,
        });

        // Observe-only: record the router's verdict on every safe turn so the dispatch threshold (θ) can
        // be tuned against real traffic before any intent actually changes behaviour (Slice A2). The
        // intent span carries the router's latency as well as its confidence.
        this.langfuseTracer.span({
          traceId,
          span: 'intent',
          input: batch,
          output: decision.verdict.intent,
          confidence: decision.verdict.confidence,
          latencyMs: decisionResult.latencyMs,
        });

        // Which evidence-based strategies fed the coach prompt — counts/scores/ids only, never the
        // strategy body text or transcript (ADR-0013). Diagnoses "the coach surfaced something
        // irrelevant" on the strategy side. Tracing never breaks the hot path (ADR-0021).
        // Verbatim strategy text is held back at the boundary (ADR-0013) in prod — only counts/ids/
        // scores cross. Outside production the call site includes the query + strategy bodies so a
        // local trace shows exactly what fed the coach.
        const fullFidelity = this.langfuseTracer.localFullFidelity;
        this.langfuseTracer.span({
          traceId,
          span: 'retrieval',
          input: fullFidelity ? batch : '',
          output: fullFidelity ? JSON.stringify(strategies.map((s) => s.content)) : '',
          latencyMs: strategyResult.latencyMs,
          metadata: {
            count: strategies.length,
            ids: strategies.map((s) => s.id),
            scores: strategies.map((s) => s.effectivenessScore ?? null),
          },
        });

        // Safety has run (tripwire + classifier). Gate at the TOOL boundary (ADR-0011): the plan's tool
        // carries its required access tier (resolved from the registry in prepare). Writes/new logging
        // ('active') get a lapsed user a resubscribe prompt HERE, after crisis screening, never instead
        // of it; reads of own data ('any', e.g. get_entry) pass. (Dashboard carries the Subscribe control.)
        if (decision.access === 'active' && !access.hasActiveAccess) {
          this.logger.log('tool gated: no active access', { userId, plan: decision.plan });
          const subscribeUrl = `${baseUrl}/dashboard`;
          await message.reply({
            content: `Your trial has ended. Subscribe to continue chatting: ${subscribeUrl}`,
          });
          this.logger.log('pipeline complete', { userId, stage: 'no-access', durationMs: Date.now() - start });
          return;
        }

        const inAftermath = await this.crisisAftermath.isQuarantined(userId);

        // Detected gameplay frustration → offer a Tilt Session (user stays in control), never
        // auto-start one. Suppressed during crisis aftermath (#05); maybeOffer self-suppresses when an
        // offer is already pending (the lapsing 'ignored' case above). (#31 / #12)
        if (!inAftermath) {
          const offerMessage = this.tilt.maybeOffer(userId, batch);
          if (offerMessage) {
            this.logger.log('tilt offered', { userId });
            await message.reply(offerMessage);
            this.logger.log('pipeline complete', { userId, stage: 'tilt-offer', durationMs: Date.now() - start });
            return;
          }
        }

        // The turn has cleared every gate: consented user, screened safe, active access, no tilt offer
        // outstanding. Run the prepared plan, which dispatches to the right handler (coach or journal).
        // The crisis-safety floor does NOT live in the router — it is always upstream of this call.
        await this.dmRouter.dispatch(
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
          decision.plan,
        );

        this.logger.log('pipeline complete', { userId, stage: decision.plan.kind, durationMs: Date.now() - start });
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    });
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
