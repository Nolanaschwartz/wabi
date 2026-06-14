import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(CoachHandler.name);

  constructor(
    private readonly coach: CoachService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly langfuseTracer: LangfuseTracer,
    private readonly memoryStore: MemoryStoreService,
    private readonly habitEngagement: HabitEngagementService,
  ) {}

  async handle(ctx: DmTurnContext): Promise<void> {
    const { message, userId, batch, session, strategies, inAftermath, timezone, traceId } = ctx;

    // Hand the already-fetched session (gathered above for the classifier) to the pure prompt
    // assembler. CoachingService never shapes the prompt string itself — buildCoachPrompt owns
    // persona + layout + read-back labels.
    // Recency-aware recall: search pulls a wide candidate pool; re-rank so recently-salient facts
    // lead before buildCoachPrompt truncates to its display budget (PRD recency-aware-memory-
    // retrieval). A MemorySearchHit already carries a numeric similarity, so it is directly rankable.
    const memories = await this.memoryStore.search(userId, batch);
    const rankedMemories = rankByRecency(memories, Date.now());
    const { system, prompt } = buildCoachPrompt({
      currentMessage: batch,
      turns: session?.turns ?? [],
      memories: rankedMemories,
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

    const streakResult = await this.habitEngagement.record(userId, 'coaching', timezone).catch(() => null);

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
  }
}
