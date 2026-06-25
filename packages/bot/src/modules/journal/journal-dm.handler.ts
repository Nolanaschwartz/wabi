import { Injectable } from '@nestjs/common';
import { JournalService } from './journal.service';
import { SpokeSessionService } from '../spoke-session/spoke-session.service';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { requireScreenedText } from '../crisis/screened';
import { InnerStateRecorderService } from '../inner-state-logger/inner-state-recorder.service';
import type { DmTurnContext } from '../coaching/coach-handler';
import type { Spoke, SpokeResult, ToolSpec } from '../coaching/spoke';

/**
 * Journal-from-DM, inline-content path. The DM router invokes this when the intent router says
 * "journal" (≥ θ) and the message already carries the entry — so a person can journal by just typing,
 * no slash command. It is the DM adapter over the SAME transport-free screened-record tail as the
 * slash path (InnerStateRecorderService): one writer (JournalService.write), one derive seam, one
 * first-use consent prompt — so the two surfaces can never drift (ADR-0031).
 *
 * Safety and access are NOT re-implemented here: the router only reaches this handler on a turn that
 * already cleared the crisis classifier (the entry text was screened this turn) and the active-access
 * gate (ADR-0011/0021). It therefore mints the `Screened` proof from that upstream verdict rather than
 * re-screening — no second classifier call on a journal-from-DM save (ADR-0030/0031).
 */
@Injectable()
export class JournalDmHandler implements Spoke {
  constructor(
    private readonly journal: JournalService,
    private readonly screening: CrisisScreeningService,
    private readonly recorder: InnerStateRecorderService,
    private readonly spokeSession: SpokeSessionService,
  ) {}

  readonly intent = 'journal';
  readonly description = 'they want to write or reflect on how they are doing';

  /** Safe default: prompt-and-arm, never save on a guess. */
  readonly defaultTool = 'give_prompt';

  readonly tools: ToolSpec[] = [
    { name: 'save_entry', description: 'Save this message verbatim as a journal entry', access: 'active' },
    {
      name: 'give_prompt',
      description: 'Offer a reflective journaling prompt and begin a two-turn entry',
      access: 'active',
    },
    { name: 'get_entry', description: "Read back the person's most recent journal entry", access: 'any' },
  ];

  /**
   * Run a fresh journal turn the router routed here. `save_entry` writes the message verbatim;
   * `get_entry` reads the latest entry back; `give_prompt` — and the safe default for any missing or
   * unknown tool — prompts and arms the two-turn floor, persisting nothing, so the hub never saves on a
   * guess.
   */
  async invoke(tool: string, ctx: DmTurnContext): Promise<SpokeResult> {
    switch (tool) {
      case 'save_entry':
        await this.handle(ctx, ctx.batch);
        return { kind: 'handled' };
      case 'get_entry':
        await this.getEntry(ctx);
        return { kind: 'handled' };
      case 'give_prompt':
      default:
        await this.beginConversation(ctx);
        return { kind: 'handled' };
    }
  }

  /**
   * Continue a two-turn capture this spoke armed: atomically consume the floor and write the turn
   * verbatim. If the floor expired between prepare() and now, fall through to coaching — the intent LLM
   * was skipped, so there is no verdict to route on.
   */
  async resume(ctx: DmTurnContext): Promise<SpokeResult> {
    if ((await this.spokeSession.consume(ctx.userId)) === 'journal') {
      await this.handle(ctx, ctx.batch);
      return { kind: 'handled' };
    }
    return { kind: 'fallthrough' };
  }

  /** `content` is the entry text — inline content (one-turn) or the whole verbatim capture turn (two-turn). */
  async handle(ctx: DmTurnContext, content: string): Promise<void> {
    // Nothing to journal (an attachment/sticker-only DM, or all whitespace): never persist a blank
    // entry — nudge instead, the same shape as the mood spoke's invalid-rating turn. (The proof would
    // normalise to structured-only anyway, but the empty write is the journal's to refuse.)
    if (content.trim().length === 0) {
      await ctx.message.reply("There's nothing to save yet — send a few words and I'll journal them.");
      return;
    }

    // The entry is the coalesced batch, already screened safe upstream this turn — mint the proof from
    // that verdict (no re-screen) and run the shared tail: persist + consent-gated derive + the
    // at-most-once consent prompt. `fromBatch` vouches only when `content` is byte-identical to the
    // screened batch; if it ever isn't (a transforming caller), it returns null and we fail SAFE by
    // re-screening via screenForRecord rather than vouching for unscreened text (ADR-0031).
    let screened = this.screening.fromBatch(ctx.screenedBatch, content, 'Journal');
    if (!screened) {
      const rescreen = await this.screening.screenForRecord(ctx.userId, { value: content, derivePrefix: 'Journal' });
      if (rescreen.crisis) {
        await ctx.message.reply(rescreen.response);
        return;
      }
      screened = rescreen.screened;
    }
    const outcome = await this.recorder.record(ctx.userId, screened, {
      // The entry minted a minable proof above (blank entries returned early), so narrow and hand the
      // `ScreenedText` to the writer (ADR-0031).
      persist: (proof) => this.journal.write(ctx.userId, requireScreenedText(proof)),
      // Identical confirmation copy to JournalController.write, so both surfaces read the same.
      confirm: ({ reflection, xpAwarded }) => `Entry saved. ${reflection} (+${xpAwarded} XP)`,
    });

    await ctx.message.reply(outcome.confirmation);

    // The consent prompt the slash path always offered but this path used to drop (ADR-0031). A DM is
    // already private, so it renders as a plain follow-up message rather than an ephemeral one.
    if (outcome.consentPrompt) {
      await ctx.message.reply({
        content: outcome.consentPrompt.content,
        components: outcome.consentPrompt.components,
      });
    }
  }

  /**
   * Bare journal intent with no inline content ("i want to journal"): arm the capture and send a
   * reflective prompt. The person's NEXT DM is screened upstream and then taken as the entry (the
   * router's pending-capture branch calls {@link handle} with that verbatim text).
   */
  async beginConversation(ctx: DmTurnContext): Promise<void> {
    await this.spokeSession.setActive(ctx.userId, 'journal');
    const prompt = await this.journal.prompt();
    await ctx.message.reply(`Sure — let's journal. ${prompt}`);
  }

  /**
   * Read back the person's most recent entry (get_entry tool). A pure read: it never writes and never
   * arms the floor, so it is allowed at any access tier (the gate lives upstream — ADR-0011). When there
   * is nothing to read, it replies gracefully rather than erroring.
   */
  async getEntry(ctx: DmTurnContext): Promise<void> {
    const entry = await this.journal.latestEntry(ctx.userId);
    if (!entry) {
      await ctx.message.reply("You haven't journaled anything yet. Want to start? Just say \"journal\".");
      return;
    }
    await ctx.message.reply(`Here's your last entry:\n\n> ${entry.content}`);
  }
}
