import { Injectable } from '@nestjs/common';
import { CommandInteraction, MessageFlags } from 'discord.js';
import { Screened } from '../crisis/screened';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { InnerStateRecorderService } from './inner-state-recorder.service';

/**
 * One person-initiated write of a free-text inner-state field — a Mood note, a Tilt trigger, a
 * Journal entry — issued from a slash command. The caller says WHAT to write (`persist`) and HOW to
 * confirm it (`confirm`); this adapter owns the Discord lifecycle (defer/editReply/followUp) and the
 * screen-then-record ordering around the transport-free tail (ADR-0031).
 */
export interface InnerStateWrite<T> {
  /** The slash-command interaction to defer, confirm on, and (maybe) follow up for the consent ask. */
  interaction: CommandInteraction;
  /**
   * The free-text field this write may carry. When present and non-blank, `value` is screened for
   * crisis and — on the safe path — derived into Memory under `derivePrefix`, and gates the first-use
   * consent prompt. Absent (or `value` blank) ⇒ a structured-only record: no screen, no derive, no
   * prompt. Bundling value + prefix makes "minable text without a prefix" unrepresentable.
   */
  freeText?: {
    value: string | null | undefined;
    /** Source word the derived Memory text is prefixed with ('Mood note' | 'Tilt trigger' | 'Journal'). */
    derivePrefix: string;
  };
  /** Optional synchronous pre-screen gate; return a reason string to reject the write before anything runs. */
  validate?: () => string | null;
  /**
   * Writes the record. Runs only on the safe path, inside the recorder, and receives the `Screened`
   * proof so a free-text writer can demand a {@link ScreenedText} rather than a bare string (ADR-0031).
   */
  persist: (screened: Screened) => Promise<T>;
  /** Builds the confirmation copy from the persist result — synchronous, so any async work lives in persist. */
  confirm: (value: T) => string;
}

export type InnerStateOutcome = { kind: 'crisis' | 'rejected' | 'logged' };

/**
 * The slash-command adapter over the screened-record write (ADR-0031). It owns the discord.js
 * lifecycle — the ephemeral defer (within Discord's 3s ack window), the confirmation `editReply`, and
 * the consent-prompt `followUp` — and the screen-then-record ordering. The choreography itself lives in
 * the transport-free `InnerStateRecorderService`; crisis screening is minted here via
 * `CrisisScreeningService.screenForRecord`, so this surface cannot reach the recorder without a proof.
 */
@Injectable()
export class InnerStateLoggerService {
  constructor(
    private readonly screening: CrisisScreeningService,
    private readonly recorder: InnerStateRecorderService,
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

    // Screen the free text and mint the proof. On a crisis the record is never written — the recorder
    // is uncallable without the `Screened` the safe path returns (ADR-0028/0031).
    const screen = await this.screening.screenForRecord(userId, freeText);
    if (screen.crisis) {
      await interaction.editReply(screen.response);
      return { kind: 'crisis' };
    }

    const outcome = await this.recorder.record(userId, screen.screened, { persist, confirm });

    // The confirmation stands alone — no buttons, no prompt copy — so answering the consent prompt
    // (which edits its OWN follow-up) can never erase it.
    await interaction.editReply({ content: outcome.confirmation });

    if (outcome.consentPrompt) {
      await interaction.followUp({
        content: outcome.consentPrompt.content,
        components: outcome.consentPrompt.components,
        flags: MessageFlags.Ephemeral,
      });
    }

    return { kind: 'logged' };
  }
}
