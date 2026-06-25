/**
 * A branded proof that a person's free-text inner-state field was screened crisis-safe (ADR-0031),
 * or that the write carried no minable free text at all. The transport-free screened-record tail
 * (`InnerStateRecorderService.record`) is uncallable without one, so a write *structurally* cannot
 * skip screening — the ADR-0028 invariant, now enforced by the type rather than by a single module
 * always running `guard`.
 *
 * `Screened` is forgeable only via an explicit `as unknown as Screened` cast, which exists at exactly
 * the auditable mint sites in `CrisisScreeningService`: the slash surface mints by running the
 * classifier, the DM surface mints by converting the verdict that already ran upstream this turn.
 */
declare const screenedBrand: unique symbol;
interface ScreenedBrand {
  readonly [screenedBrand]: true;
}

/**
 * A discriminated union over the two — and only two — shapes a screened record can take, so the
 * "minable text without a prefix" / "prefix without text" states are *unrepresentable* rather than
 * merely unused. `freeText !== null` narrows to the minable shape, where `derivePrefix` is a guaranteed
 * `string` (the recorder relies on this when it interpolates `${derivePrefix}: ${freeText}`).
 *
 * - minable: the exact crisis-safe free text this write carried — byte-identical to what was screened,
 *   so the derived Memory text is this value plus its prefix.
 * - structured-only: no minable free text (a rating-only record, or blank/whitespace input) — no screen
 *   ran, nothing derives, no consent prompt.
 */
/**
 * The minable arm of {@link Screened}: a proof carrying the exact crisis-safe free text a write
 * persists. A writer that *stores* free text (a Journal entry, a Mood note) takes this — not the union
 * and not a bare `string` — so persisting unscreened text, or a structured-only proof, is a compile
 * error at the call site (ADR-0031). Narrow to it from a `Screened` with `screened.freeText !== null`.
 */
export type ScreenedText = ScreenedBrand & {
  readonly freeText: string;
  readonly derivePrefix: string;
};

export type Screened =
  | ScreenedText
  | (ScreenedBrand & { readonly freeText: null; readonly derivePrefix: null });

/**
 * Narrow a {@link Screened} to its minable {@link ScreenedText} arm, throwing if the proof carries no
 * free text. The single chokepoint a free-text writer (a Journal entry) uses instead of hand-rolling the
 * `freeText === null` guard, so the screened-record invariant (ADR-0031) lives in one place next to the
 * brand it guards rather than copied at each persist site. Defensive: callers reject blank input upstream,
 * so a structured-only proof never reaches here in practice — but if one ever does, this fails loud rather
 * than silently persisting a null free-text field.
 */
export function requireScreenedText(screened: Screened): ScreenedText {
  if (screened.freeText === null) {
    throw new Error('a free-text write requires screened free text');
  }
  return screened;
}

/**
 * A branded proof that this turn's coalesced batch was screened crisis-safe by the upstream DM
 * classifier (ADR-0031). It carries the EXACT screened text so a downstream record write can be bound
 * to it: `CrisisScreeningService.fromBatch` mints a `Screened` only when the text a handler is about to
 * persist is byte-identical to `text`. Minted only past the per-turn safe verdict, at the single
 * auditable forge in `CrisisScreeningService` — so a `Screened` derived from it cannot vouch for text
 * that was never screened, and no second classifier call is needed on the DM record path (ADR-0030).
 */
declare const dmScreenedBatchBrand: unique symbol;
export interface DmScreenedBatch {
  readonly [dmScreenedBatchBrand]: true;
  /** The exact coalesced batch the classifier screened safe this turn. */
  readonly text: string;
}
