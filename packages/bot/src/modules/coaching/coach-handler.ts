import { Injectable } from '@nestjs/common';
import { Message } from 'discord.js';
import { CoachService } from './coach.service';
import { buildCoachPrompt } from './coach-prompt';
import { splitMessage } from './message-splitter';
import { SessionBufferService, type SessionContext } from '../session-buffer/session-buffer.service';
import { LangfuseTracer } from '../langfuse/langfuse-tracer.service';
import { MemoryStoreService } from '../memory/memory-store.service';
import { rankByRecency } from '../memory/memory-ranker';
import { HabitEngagementService } from '../habit-engagement/habit-engagement.service';
import type { StrategyPoint } from '../strategy-retrieval/strategy-retrieval.service';
import { JsonLogger } from '../../lib/json-logger';

/**
 * The already-safe, already-active turn handed to a DM handler. CoachingService gathers all of this
 * upstream (user lookup, crisis screening, access gate, tilt offer) — a handler is only ever invoked
 * on a turn that has cleared every gate, so it never re-implements safety. (ADR-0011/0021.)
 */
export interface DmTurnContext {
  message: Message;
  userId: string;
  /** Coalesced message text — what the classifier and retrieval saw. */
  batch: string;
  /** Live session context fetched once upstream for the classifier, reused here for the prompt. */
  session: SessionContext | null;
  strategies: StrategyPoint[];
  inAftermath: boolean;
  timezone: string;
  traceId: string;
}

/**
 * The coach body, lifted out of CoachingService verbatim so the router has a handler to dispatch to.
 * Owns: recency-ranked memory recall → build coach prompt → generate → session-buffer append →
 * streak record → fire-and-forget memory derive → send reply. Shapes no safety/gating decisions —
 * those stay upstream in CoachingService.
 */
@Injectable()
export class CoachHandler {
  private readonly logger = new JsonLogger(CoachHandler.name);

  constructor(
    private readonly coach: CoachService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly langfuseTracer: LangfuseTracer,
    private readonly memoryStore: MemoryStoreService,
    private readonly habitEngagement: HabitEngagementService,
  ) {}

  async handle(ctx: DmTurnContext): Promise<void> {
    const { message, userId, batch, session, strategies, inAftermath, timezone, traceId } = ctx;
    const start = Date.now();

    this.logger.log('coach handler start', { userId });

    // Hand the already-fetched session (gathered above for the classifier) to the pure prompt
    // assembler. CoachingService never shapes the prompt string itself — buildCoachPrompt owns
    // persona + layout + read-back labels.
    // Recency-aware recall: search pulls a wide candidate pool; re-rank so recently-salient facts
    // lead before buildCoachPrompt truncates to its display budget (PRD recency-aware-memory-
    // retrieval). A MemorySearchHit already carries a numeric similarity, so it is directly rankable.
    const memoryStart = Date.now();
    // Recall is best-effort: a vector-store outage must degrade to "no memories", never silence the
    // coach (ADR-0021). Mirrors strategy retrieval's .catch upstream in CoachingService.
    const memories = await this.memoryStore.search(userId, batch).catch(() => []);
    const memoryLatency = Date.now() - memoryStart;

    // Diagnose "the coach brought up old/irrelevant stuff": record how many memories were recalled and
    // their similarity scores / ids — never the verbatim memory text or transcript (ADR-0013). Tracing
    // never breaks the hot path (ADR-0021).
    this.langfuseTracer.span({
      traceId,
      span: 'memory',
      input: '',
      output: '',
      latencyMs: memoryLatency,
      metadata: {
        count: memories.length,
        ids: memories.map((m) => m.id),
        similarities: memories.map((m) => m.similarity),
      },
    });

    const rankedMemories = rankByRecency(memories, Date.now());
    const { system, prompt } = buildCoachPrompt({
      currentMessage: batch,
      turns: session?.turns ?? [],
      memories: rankedMemories,
      strategies,
      inAftermath,
    });

    const coachStart = Date.now();
    const generation = await this.coach.generateDetailed(system, prompt);
    const coachLatency = Date.now() - coachStart;
    const reply = generation.text;

    // Cost/identity signal: the model that produced the reply and its token usage (absent when the
    // provider doesn't report it). Emitted for BOTH outcomes — an empty/refused generation still burned
    // tokens, and that failure turn is exactly the one cost monitoring must be able to inspect.
    this.langfuseTracer.span({
      traceId,
      span: 'coach',
      input: prompt,
      output: reply,
      latencyMs: coachLatency,
      model: generation.model,
      usage: generation.usage,
    });

    if (!reply) {
      this.logger.warn('coach returned empty, sending fallback', { userId, latencyMs: coachLatency });
      // Eval signal: an empty/refused generation is a quality failure worth scoring (ADR-0014).
      this.recordScores(traceId, coachLatency, 0);
      await message.reply("I'm not sure how to respond to that right now. Want to try again?");
      return;
    }

    this.logger.log('coach reply generated', { userId, latencyMs: coachLatency, replyLength: reply.length });

    await this.sessionBuffer.append(userId, 'user', message.content);
    await this.sessionBuffer.append(userId, 'assistant', reply);

    const streakResult = await this.habitEngagement.record(userId, 'coaching', timezone).catch(() => null);

    // Per-turn quality scores for ADR-0014's eval store: a latency-SLA pass/fail and a reply-present
    // signal. Full-fidelity (not span-sampled) inside the tracer.
    this.recordScores(traceId, coachLatency, 1);

    // Send the reply BEFORE persisting long-term memory. deriveAndStore runs mem0's hybrid
    // vector+graph extraction (~20s+ since ADR-0025), which must never delay the user-visible reply.
    const parts = splitMessage(reply);
    for (const part of parts) {
      await message.reply(part);
    }
    if (streakResult && streakResult.message) {
      await message.reply(streakResult.message);
    }

    this.logger.log('coach handler complete', { userId, durationMs: Date.now() - start, replyParts: parts.length });

    // Fire-and-forget: persistence failures are already logged inside deriveAndStore, and memory is
    // not needed to answer this turn. Awaiting it here previously starved the reply.
    void this.memoryStore.deriveAndStore(userId, `${message.content} | ${reply}`);
  }

  // Record the turn's quality scores. Wrapped so a scoring failure can never break the hot path
  // (ADR-0021) — the tracer also swallows internally, this is belt-and-suspenders.
  private recordScores(traceId: string, coachLatencyMs: number, replyPresent: 0 | 1): void {
    try {
      this.langfuseTracer.score(traceId, 'latency_sla', coachLatencyMs <= COACH_LATENCY_SLA_MS ? 1 : 0);
      this.langfuseTracer.score(traceId, 'reply_present', replyPresent);
    } catch (err) {
      this.logger.warn('scoring failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// A coach turn should land well under this; a turn over it is flagged (score 0) for eval review.
const COACH_LATENCY_SLA_MS = 8000;
