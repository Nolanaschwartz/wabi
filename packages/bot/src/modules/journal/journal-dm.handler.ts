import { Injectable } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalSessionService } from './journal-session.service';
import { InnerStateMemoryService } from '../memory/inner-state-memory.service';
import type { DmTurnContext } from '../coaching/coach-handler';

/**
 * Journal-from-DM, inline-content path. The DM router invokes this when the intent router says
 * "journal" (≥ θ) and the message already carries the entry — so a person can journal by just typing,
 * no slash command. It reuses the SAME writer as `/journal write` (JournalService.write → persist +
 * reflection + XP/streak) so the two surfaces can never drift, and derives Memory under the identical
 * `Journal:` prefix as the slash path (InnerStateLogger).
 *
 * Safety and access are NOT re-implemented here: the router only reaches this handler on a turn that
 * already cleared the crisis classifier (the entry text was screened this turn) and the active-access
 * gate (ADR-0011/0021). The handler therefore writes directly — the slash path's crisis guard is for
 * the slash surface, which has no upstream classifier.
 */
@Injectable()
export class JournalDmHandler {
  constructor(
    private readonly journal: JournalService,
    private readonly innerStateMemory: InnerStateMemoryService,
    private readonly journalSession: JournalSessionService,
  ) {}

  /** `content` is the entry text — inline content (one-turn) or the whole verbatim capture turn (two-turn). */
  async handle(ctx: DmTurnContext, content: string): Promise<void> {
    const { reflection, xpAwarded } = await this.journal.write(ctx.userId, content);

    // Memory parity with the slash path: same prefix, same fire-and-forget (deriveIfConsented is
    // fail-soft and never throws), so the confirmation never waits on Mem0. Unconsented users get the
    // entry saved but not mined — the gate lives inside deriveIfConsented.
    void this.innerStateMemory.deriveIfConsented(ctx.userId, `Journal: ${content}`);

    // Identical confirmation copy to JournalController.write, so both surfaces read the same.
    await ctx.message.reply(`Entry saved. ${reflection} (+${xpAwarded} XP)`);
  }

  /**
   * Bare journal intent with no inline content ("i want to journal"): arm the capture and send a
   * reflective prompt. The person's NEXT DM is screened upstream and then taken as the entry (the
   * router's pending-capture branch calls {@link handle} with that verbatim text).
   */
  async beginConversation(ctx: DmTurnContext): Promise<void> {
    await this.journalSession.setPending(ctx.userId);
    const prompt = await this.journal.prompt();
    await ctx.message.reply(`Sure — let's journal. ${prompt}`);
  }
}
