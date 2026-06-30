import { Injectable } from '@nestjs/common';
import { ClassifierService } from '../crisis/classifier.service';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { Message, DMChannel } from 'discord.js';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { ClassifierContextAssembler } from './classifier-context-assembler';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';
import { StrategyRetrievalService } from '../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../billing/access-resolver';
import { CrisisAftermathService } from '../crisis-aftermath/crisis-aftermath.service';
import { EscalationService } from '../crisis/escalation.service';
import { TiltService } from '../tilt/tilt.service';
import { DmRouterService } from './dm-router.service';
import { setupLinkMessage, finishOnboardingMessage } from '../../lib/setup-link';
import { expandAreas } from '@wabi/shared';
import { JsonLogger, withTraceId } from '../../lib/json-logger';
import { startActiveObservation, getActiveTraceId } from '@wabi/shared/otel';
import type { GenerationCallTelemetry } from '@wabi/shared/generate';

// Below this many buffered turns the session is treated as "cold" for strategy retrieval: a fresh
// Conversation carries too little signal, so we seed the query with the user's Improvement Areas
// (ADR-0044 cold-start augmentation). At or above it the live Conversation drives retrieval unaided.
const COLD_BUFFER_TURN_THRESHOLD = 2;

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
    private readonly dmRouter: DmRouterService,
    private readonly classifierContextAssembler: ClassifierContextAssembler,
    private readonly screening: CrisisScreeningService,
  ) {}

  async handle(message: Message): Promise<void> {
    // One coaching turn = one trace tree rooted at this content-free `turn` span (ADR-0038). The OTEL
    // trace id minted by startActiveObservation is canonical: it correlates logs (withTraceId) and
    // every child span/score for the turn. No crypto.randomUUID — the OTEL trace id IS the turn id.
    return startActiveObservation('turn', async () => {
      const traceId = getActiveTraceId() ?? '';
      return withTraceId(traceId, () => this.runTurn(message, traceId));
    });
  }

  private async runTurn(message: Message, traceId: string): Promise<void> {
    const userId = message.author.id;
    const start = Date.now();

    this.logger.log('message received', { userId, traceId });

    // One read of the User row feeds all three facts the turn needs: the consent gate, the coach-prompt
    // timezone, and the Active Access decision. (The full row already carries consent + timezone, so a
    // separate projected consent read would just double the round-trip.) Access is resolved here but NOT
    // gated yet: the crisis classifier is the safety floor and must run for every consented user — active
    // OR lapsed (ADR-0011/0021): a paraphrased crisis with no tripwire keyword is only caught by the LLM,
    // and a lapsed at-risk user is exactly who must not be missed. Coaching itself is gated AFTER
    // classification, below.
    const { access, consented, timezone, onboardingCompleted, improveAreas, interests } =
      await this.accessResolver.resolveAccount(userId);

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://wabi.gg';

    if (!consented) {
      this.logger.log('user no consent', { userId });
      await message.reply({
        content: setupLinkMessage(baseUrl),
      });
      return;
    }

    // Consent-tier onboarding gate (ADR-0044). A consented user who never finished web Onboarding
    // (`onboardingCompletedAt` null) is treated like a pre-setup user: tripwire floor only, no
    // classifier, no coaching. This fires as a sibling of the unconsented branch above and BEFORE the
    // classify∥strategy∥prepare block — the un-onboarded path stays cheap and structurally identical to
    // the unconsented path (one tier, one nudge, no inference). The always-on crisis tripwire runs
    // UPSTREAM of this whole method (EchoController), so explicit crisis still escalates regardless;
    // only the nuanced classifier is deferred until the person becomes a real coaching user.
    if (!onboardingCompleted) {
      this.logger.log('user onboarding incomplete', { userId });
      await message.reply({
        content: finishOnboardingMessage(baseUrl),
      });
      return;
    }

    // Tilt offer response: if we previously offered a Tilt Session, this turn may be the user's
    // accept/decline. The whole state machine lives in TiltService now; here we just route its
    // reply. accepted/declined end the turn; none/ignored fall through to coaching.
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
      const classifierContext = await this.classifierContextAssembler.assemble(userId, session);

      // Cold-start strategy retrieval (ADR-0044). On a fresh Conversation there is no derived Memory and
      // little-to-no live context, so a bare-message Qdrant fetch is cold and generic. When the buffer is
      // cold we seed the retrieval query with the user's Improvement Area phrases (expandAreas) so day-1
      // fetches are relevant; once the buffer is warm the live Conversation carries the query and we pass
      // the message unchanged. This is a query-STRING change at the call site only — strategy-retrieval
      // stays pure embedding search. Interests never touch retrieval (rapport-only, ADR-0029).
      const coldBuffer = (session?.turns.length ?? 0) < COLD_BUFFER_TURN_THRESHOLD;
      const areaPhrases = expandAreas(improveAreas);
      const strategyQuery =
        coldBuffer && areaPhrases.length > 0 ? [batch, ...areaPhrases].join(' ') : batch;

      // The router's routing decision runs IN this block — parallel with the crisis classifier and
      // strategy search, so it costs no added serial latency. prepare() is side-effect-free and the
      // whole routing decision (pending-capture check, intent classifier, θ, inline extraction) lives
      // behind it; the dispatch is deferred to the safe path below. The crisis floor stays upstream of
      // the router: a crisis short-circuits here and the plan is discarded. (ADR-0021: safety is the
      // floor; routing is downstream of it.)
      // Time each parallel op independently so its span records its own latency — an operator can
      // then see whether classification, retrieval, or routing was the slow part of the turn.
      // Capture the classifier LLM's model/usage out-of-band (the verdict stays its only return) so the
      // `classify` span can be attributed; the router's equivalent rides on the routing decision.
      let classifyTelemetry: GenerationCallTelemetry | undefined;
      const [classifyResult, strategyResult, decisionResult] = await Promise.all([
        measure(
          this.classifier.classify(batch, classifierContext, (t) => {
            classifyTelemetry = t;
          }),
        ),
        measure(this.strategyRetrieval.search(strategyQuery).catch(() => [])),
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
        // Latch SYNCHRONOUSLY the instant the verdict is crisis — before any span of this turn ends —
        // so the OTEL export filter drops the ENTIRE trace tree (root + every child) in production
        // (ADR-0024). Dev (localFullFidelity) retains it for classifier debugging.
        this.langfuseTracer.latchCrisis(traceId);
        this.burstCoalescer.cancel(userId);
        // Crisis on a capture turn (journal or mood holds the floor): drop the spoke floor so the
        // crisis text never reaches a spoke writer and a later DM routes fresh. (Quarantine clears
        // buffers too, but the floor is the router's to clear.) Best-effort — a marker expires on TTL.
        // Read the router's own `isCapture` fact, not its internal plan shape (ADR-0030).
        if (decision.isCapture) {
          await this.dmRouter.clearPending(userId);
        }
        // Fail CLOSED on content: the trace-id export drop is the primary defense, but if it is ever
        // defeated (e.g. the active trace id resolved empty so the latch key mismatches the span's real
        // id), the verbatim crisis text must still never reach Langfuse. So gate the input by
        // localFullFidelity exactly like retrieval/memory — prod carries no crisis content at all, dev
        // keeps it for classifier debugging (ADR-0021/0024).
        this.langfuseTracer.traceObservation({
          name: 'classify',
          input: this.langfuseTracer.localFullFidelity ? batch : '',
          output: 'crisis',
          kind: 'generation',
          latencyMs: classifyResult.latencyMs,
          model: classifyTelemetry?.model,
          usage: classifyTelemetry?.usage,
        });
        // One seam for the whole crisis response: resources + ONE Escalation Event ('classifier')
        // + quarantine + ONE follow-up. Escalation returns the renderable payload; we send it on the
        // DM channel. No more hand-assembling the sequence here and again on the tripwire path.
        // (ADR-0006/0010/0028.)
        const response = await this.escalation.escalate(userId, 'classifier', 'conversation');
        await message.reply(response);
        this.logger.log('pipeline complete', { userId, stage: 'crisis', durationMs: Date.now() - start });
        return;
      }

      this.langfuseTracer.traceObservation({
        name: 'classify',
        input: batch,
        output: 'safe',
        kind: 'generation',
        latencyMs: classifyResult.latencyMs,
        model: classifyTelemetry?.model,
        usage: classifyTelemetry?.usage,
      });

      // Record the router's verdict on every safe turn so the dispatch threshold (θ) can be tuned
      // from Langfuse traces. The intent span carries the router's latency and its confidence.
      this.langfuseTracer.traceObservation({
        name: 'intent',
        input: batch,
        output: decision.verdict.intent,
        kind: 'generation',
        confidence: decision.verdict.confidence,
        latencyMs: decisionResult.latencyMs,
        model: decision.verdictTelemetry?.model,
        usage: decision.verdictTelemetry?.usage,
      });

      // Which evidence-based strategies fed the coach prompt — counts/scores/ids only; the verbatim
      // strategy body is held back at the boundary in prod (ADR-0013), while outside production the call
      // site includes the query + strategy bodies so a local trace shows exactly what fed the coach.
      // Diagnoses "the coach surfaced something irrelevant"; tracing never breaks the hot path (ADR-0021).
      const fullFidelity = this.langfuseTracer.localFullFidelity;
      this.langfuseTracer.traceObservation({
        name: 'retrieval',
        input: fullFidelity ? batch : '',
        output: fullFidelity ? JSON.stringify(strategies.map((s) => s.content)) : '',
        kind: 'span',
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
      // offer is already pending (the lapsing 'ignored' case above).
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
          // Bind the proof to the exact text just classified safe, so a spoke can mint a Screened
          // record proof without a second classifier call (ADR-0030/0031).
          screenedBatch: this.screening.screenedBatch(batch),
          session,
          strategies,
          inAftermath,
          timezone,
          // Read-direct signup Personalization, threaded like timezone (ADR-0044). Only onboarded users
          // reach here (the gate above), so `areas` is non-empty by the ≥1-area completion rule. The
          // coach prompt renders it; Interests are rapport-only and never touch retrieval.
          personalization: { areas: improveAreas, interests },
          traceId,
        },
        decision.plan,
      );

      this.logger.log('pipeline complete', { userId, stage: decision.plan.kind, durationMs: Date.now() - start });
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  cancelPending(userId: string): void {
    this.burstCoalescer.cancel(userId);
  }
}
