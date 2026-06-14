import { Injectable } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
import { EscalationService, CrisisResponse } from './escalation.service';
import { Screened } from './screened';

/** The optional free-text field a screened-record write may carry, with its Memory derive prefix. */
export interface FreeTextField {
  value: string | null | undefined;
  derivePrefix: string;
}

/** The outcome of screening one piece of free-text input. */
export type ScreeningVerdict =
  | { kind: 'crisis'; response: CrisisResponse }
  | { kind: 'safe' };

/**
 * The result of screening a write for the record tail: a crisis (the caller renders `response` and
 * never records), or a clear screen carrying the `Screened` proof the recorder requires (ADR-0031).
 */
export type ScreenedForRecord =
  | { crisis: true; response: CrisisResponse }
  | { crisis: false; screened: Screened };

/**
 * The outcome of a screened persist: either a crisis was caught (the record was NOT written and the
 * caller renders `response`), or the free text cleared and the persist ran, yielding `value`.
 */
export type ScreenedRecord<T> =
  | { crisis: true; response: CrisisResponse }
  | { crisis: false; value: T };

@Injectable()
export class CrisisScreeningService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly escalation: EscalationService,
  ) {}

  private readonly explicitPatterns: RegExp[] = [
    /\bI don'?t want to live\b/i,
    /\bI don'?t want to be alive\b/i,
    /\bI don'?t want to wake up\b/i,
    /\bI want to die\b/i,
    /\bI want to kill myself\b/i,
    /\bsuicid/i,
    /\bending it all\b/i,
    /\bno reason to live\b/i,
    /\bI'?m better off dead\b/i,
    /\bI'?m going to hurt myself\b/i,
    /\bI'?m going to kill myself\b/i,
    /\bsay goodbye\b/i,
    /\bI can'?t go on\b/i,
    /\bthere'?s no point\b/i,
    /\bI want to end this\b/i,
    /\bI'?m going to end it\b/i,
    /\bI wish I were dead\b/i,
    /\bI want to go to sleep and never wake up\b/i,
    /\bI can'?t do this anymore\b/i,
    /\bI'?m so tired of living\b/i,
    /\bI'?m going to jump\b/i,
    /\bI have a plan to kill myself\b/i,
    /\bI want to overdose\b/i,
    /\bI want to slit my wrists\b/i,
    /\bI'?m going to hang myself\b/i,
  ];

  tripwire(text: string): boolean {
    const lowerText = text.toLowerCase();
    for (const pattern of this.explicitPatterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Full screening for one piece of a person's free-text input from any atomic surface — a Journal
   * Entry, a Mood note, a Tilt trigger (ADR-0028). Runs the two crisis-detection layers cheap-first
   * (tripwire then classifier) and, on a hit, performs a Crisis Escalation that surfaces resources +
   * records one Escalation Event but does NOT open the DM-session aftermath window — a logged field is
   * not a Conversation, so it escalates on the `'field'` surface. Returns the renderable crisis response
   * for the caller to send on its own surface, or `{ kind: 'safe' }`.
   */
  async screen(userId: string, content: string): Promise<ScreeningVerdict> {
    if (this.tripwire(content)) {
      const response = await this.escalation.escalate(userId, 'tripwire', 'field');
      return { kind: 'crisis', response };
    }

    const classification = await this.classifier.classify(content);
    if (classification === 'crisis') {
      const response = await this.escalation.escalate(userId, 'classifier', 'field');
      return { kind: 'crisis', response };
    }

    return { kind: 'safe' };
  }

  /**
   * The shared screened-record path (ADR-0028): any surface persisting a free-text inner-state field
   * calls this instead of writing directly, so screening can never be silently skipped. Screens the
   * free text first; on a crisis it escalates and returns the response WITHOUT running `persist`. When
   * the text clears — or is absent (a structured-only record) — it runs `persist` and returns its
   * value.
   */
  async guard<T>(
    userId: string,
    content: string | null | undefined,
    persist: () => Promise<T>,
  ): Promise<ScreenedRecord<T>> {
    if (content && content.trim().length > 0) {
      const verdict = await this.screen(userId, content);
      if (verdict.kind === 'crisis') {
        return { crisis: true, response: verdict.response };
      }
    }

    const value = await persist();
    return { crisis: false, value };
  }

  /**
   * The slash mint site for the transport-agnostic screened-record write (ADR-0031). Screens the
   * field's free text first; on a crisis it escalates and returns the response WITHOUT a proof, so the
   * caller cannot record. When the text clears — or is absent/blank (a structured-only record) — it
   * returns a `Screened` proof carrying the exact safe text (or `null`) for the recorder to persist
   * and derive. This is the only place a fresh classifier run mints a proof; the DM surface mints from
   * its upstream verdict instead, so a journal-from-DM save is never re-screened.
   */
  async screenForRecord(
    userId: string,
    freeText?: FreeTextField,
  ): Promise<ScreenedForRecord> {
    const value = freeText?.value;
    if (value && value.trim().length > 0) {
      const verdict = await this.screen(userId, value);
      if (verdict.kind === 'crisis') {
        return { crisis: true, response: verdict.response };
      }
      return { crisis: false, screened: mintScreened(value, freeText!.derivePrefix) };
    }
    return { crisis: false, screened: mintScreened(null, null) };
  }

  /**
   * The DM mint site (ADR-0031). On the DM coaching path the turn's free text was ALREADY screened by
   * the upstream Crisis Classifier this turn — a spoke handler only runs on a turn that cleared it
   * (ADR-0021/0030). This converts that standing verdict into a `Screened` proof WITHOUT a second,
   * serial classifier call (the latency ADR-0030 protects). The caller MUST pass the exact text that
   * was screened — the coalesced batch, persisted byte-identical — so the proof's integrity holds; a
   * surface that transforms the text before persisting must re-screen via {@link screenForRecord}.
   */
  screenedFromUpstream(content: string, derivePrefix: string): Screened {
    return mintScreened(content, derivePrefix);
  }
}

/**
 * The single auditable forge of a `Screened` proof. Co-located with screening so the cast lives
 * beside the classifier call that justifies it (ADR-0031), and the single place blank/whitespace text
 * is normalised to the structured-only shape: a mint with no minable text — `null`, `''`, or all
 * whitespace — always yields `{ freeText: null, derivePrefix: null }`, so the recorder never derives an
 * empty body or prompts for consent over a non-entry, regardless of which surface minted it. The exact
 * (un-trimmed) screened string is preserved for the minable case, keeping derive ≡ persisted text.
 */
function mintScreened(freeText: string | null, derivePrefix: string | null): Screened {
  if (freeText !== null && freeText.trim().length > 0) {
    return { freeText, derivePrefix } as unknown as Screened;
  }
  return { freeText: null, derivePrefix: null } as unknown as Screened;
}
