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
export type Screened =
  | (ScreenedBrand & { readonly freeText: string; readonly derivePrefix: string })
  | (ScreenedBrand & { readonly freeText: null; readonly derivePrefix: null });

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
