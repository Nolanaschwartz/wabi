import { Injectable } from '@nestjs/common';
import { Screened } from '../crisis/screened';
import { InnerStateMemoryService } from '../memory/inner-state-memory.service';
import { InnerStateConsentService, ConsentSurface } from '../memory/inner-state-consent.service';

/**
 * What a record write does once screening has cleared: persist the record, then build its confirmation
 * copy. `persist` runs first and yields `T`; `confirm` is synchronous, so any async work (a trend
 * read, an XP award) lives inside `persist` and is threaded through `T`.
 */
export interface RecordWrite<T> {
  persist: () => Promise<T>;
  confirm: (value: T) => string;
}

/**
 * The result of the screened-record tail — data, not transport. The surface adapter renders it: the
 * confirmation copy, and the first-use consent prompt when one is owed (`null` otherwise).
 */
export type Outcome<T> = {
  kind: 'logged';
  value: T;
  confirmation: string;
  consentPrompt: ConsentSurface | null;
};

/**
 * The transport-free screened-record write (ADR-0031). It owns the persist → derive → consent-decision
 * tail — the choreography that broke three times when copied across controllers — and renders nothing,
 * so its interface is its own test surface (no discord.js mock). Crisis screening has already happened
 * upstream: the `Screened` proof is the evidence, and the module is uncallable without it, so a write
 * structurally cannot skip screening (the ADR-0028 invariant, now carried by the type).
 *
 * The derive stays best-effort and fire-and-forget — a slow Mem0 round-trip never blocks the
 * confirmation — and runs only when the proof carried minable free text, the same flag that gates the
 * consent prompt, so the two can never disagree.
 */
@Injectable()
export class InnerStateRecorderService {
  constructor(
    private readonly innerStateMemory: InnerStateMemoryService,
    private readonly consent: InnerStateConsentService,
  ) {}

  async record<T>(
    userId: string,
    screened: Screened,
    write: RecordWrite<T>,
  ): Promise<Outcome<T>> {
    const value = await write.persist();

    // The proof's `freeText` is the exact screened string (or null for no minable text). When present,
    // derive it under its prefix — screened text ≡ derived text minus the prefix (ADR-0028/0031).
    if (screened.freeText !== null) {
      void this.innerStateMemory.deriveIfConsented(
        userId,
        `${screened.derivePrefix}: ${screened.freeText}`,
      );
    }

    const confirmation = write.confirm(value);

    // Same minable flag gates the at-most-once consent ask; a structured-only record never asks.
    const consentPrompt =
      screened.freeText !== null ? await this.consent.prepareFirstUsePrompt(userId) : null;

    return { kind: 'logged', value, confirmation, consentPrompt };
  }
}
