import { Injectable } from '@nestjs/common';
import { CommandInteraction, MessageFlags } from 'discord.js';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { InnerStateMemoryService } from '../memory/inner-state-memory.service';
import { InnerStateConsentService } from '../memory/inner-state-consent.service';

/**
 * One person-initiated write of a free-text inner-state field — a Mood note, a Tilt trigger, a
 * Journal entry. The caller says WHAT to write (`persist`) and HOW to confirm it (`confirm`); the
 * logger owns the screened-record choreography around it (ADR-0028/0029).
 */
export interface InnerStateWrite<T> {
  /** The slash-command interaction to defer, confirm on, and (maybe) follow up for the consent ask. */
  interaction: CommandInteraction;
  /**
   * The free-text field this write may carry. When present, `value` is screened for crisis and —
   * when non-blank — derived into Memory under `derivePrefix` (so screened text ≡ derived text minus
   * the prefix), and gates the first-use consent prompt. Absent (or `value` blank) ⇒ a structured-only
   * record: no screen, no derive, no prompt. Bundling value + prefix makes "minable text without a
   * prefix" unrepresentable, so a future capture surface can't desync them.
   */
  freeText?: {
    value: string | null | undefined;
    /** Source word the derived Memory text is prefixed with ('Mood note' | 'Tilt trigger' | 'Journal'). */
    derivePrefix: string;
  };
  /** Optional synchronous pre-screen gate; return a reason string to reject the write before anything runs. */
  validate?: () => string | null;
  /** Writes the record. Runs only on the safe path, inside the crisis guard's success closure. */
  persist: () => Promise<T>;
  /** Builds the confirmation copy from the persist result — synchronous, so any async work lives in persist. */
  confirm: (value: T) => string;
}

export type InnerStateOutcome = { kind: 'crisis' | 'rejected' | 'logged' };

/**
 * The single deep module behind the screened-record write path. Mood / Tilt / Journal hand it a
 * `persist` and a `confirm`; the "screen → persist → derive → confirm → ask-once" choreography — which
 * broke three times when copied across three controllers (commits 7f0e4c08, fd4291fb) — lives here,
 * once. The crisis seam (`guard`), the derive seam (`deriveIfConsented`), and the consent seam
 * (`prepareFirstUsePrompt`) are reused unchanged; this module only owns the ordering between them and
 * the `CommandInteraction`.
 */
@Injectable()
export class InnerStateLoggerService {
  constructor(
    private readonly screening: CrisisScreeningService,
    private readonly innerStateMemory: InnerStateMemoryService,
    private readonly consent: InnerStateConsentService,
  ) {}

  async log<T>(write: InnerStateWrite<T>): Promise<InnerStateOutcome> {
    const { interaction, freeText, validate, persist, confirm } = write;
    const userId = interaction.user.id;

    // First act, always: inner state never renders on a social surface (ADR-0002/0017), and these
    // commands register for the hub Guild too — a non-ephemeral reply would broadcast it.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Reject before any screening / persist / derive, so a rejected write costs no classifier call.
    const rejection = validate?.() ?? null;
    if (rejection) {
      await interaction.editReply({ content: rejection });
      return { kind: 'rejected' };
    }

    // "Did this write carry minable free text?" — computed once and shared by BOTH the derive and the
    // consent prompt, so the two can never disagree (the bug that broke three times: 7f0e4c08).
    const minable = !!freeText?.value?.trim();

    // Screen the free text, then persist + derive together inside the guard's success closure: crisis
    // text reaches neither Postgres nor derived Memory, because the closure never runs on a crisis
    // verdict (ADR-0028/0029). The derived text is exactly the screened text plus its source prefix.
    const result = await this.screening.guard(userId, freeText?.value, async () => {
      const value = await persist();
      if (minable && freeText) {
        // Fire-and-forget: deriveIfConsented is best-effort and fail-soft (it never throws), so the
        // user's confirmation never blocks on a slow Mem0 round-trip. It stays INSIDE the guard
        // closure, so crisis text still physically cannot reach derived Memory (ADR-0028/0029).
        void this.innerStateMemory.deriveIfConsented(
          userId,
          `${freeText.derivePrefix}: ${freeText.value}`,
        );
      }
      return value;
    });

    if (result.crisis) {
      await interaction.editReply(result.response);
      return { kind: 'crisis' };
    }

    // The confirmation stands alone — no buttons, no prompt copy — so answering the consent prompt
    // (which edits its OWN follow-up) can never erase it.
    await interaction.editReply({ content: confirm(result.value) });

    if (minable) {
      const prompt = await this.consent.prepareFirstUsePrompt(userId);
      if (prompt) {
        await interaction.followUp({
          content: prompt.content,
          components: prompt.components,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    return { kind: 'logged' };
  }
}
