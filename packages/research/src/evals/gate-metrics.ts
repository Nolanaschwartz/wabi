/**
 * Pure quality + trust metrics for the relevance gate, scored against an independent intent rubric
 * (ADR-0040). No I/O — the eval scripts feed it the per-item results and print what it returns.
 *
 * Reject is the POSITIVE class: the gate exists to discard irrelevant papers, so precision/recall
 * measure how well it catches the rejects. The gate fails OPEN (empty/uncertain → keep), and the
 * metrics mirror that exactly so an audit reflects production behaviour, not an idealised gate.
 *
 * Trust metrics exist because the gate calls a reasoning model whose determinism is unproven and
 * which can return empty text that fails open to keep:
 *   - flipRate:       fraction of items whose N verdicts were not unanimous (single-run numbers are
 *                     only trustworthy when this is ~0).
 *   - emptyReplyRate: fraction of all calls that returned empty/starved text (shows how much "keep
 *                     accuracy" is real keeps vs fail-open masking).
 */
export type Label = 'keep' | 'reject';

export interface GateItemResult {
  /** Ground truth from the intent rubric. */
  expected: Label;
  /** One verdict per gate run (N≥1). Collapsed by majority vote, ties → keep (fail open). */
  predictions: Label[];
  /** Per-call empty-reply flags, aligned with `predictions`. An empty call counts as a keep vote. */
  emptyReplies: boolean[];
}

export interface GateMetrics {
  accuracy: number;
  rejectPrecision: number;
  rejectRecall: number;
  flipRate: number;
  emptyReplyRate: number;
}

/** The production-faithful vote for each call: an empty reply is a keep, otherwise the model's label. */
function effectiveVotes(r: GateItemResult): Label[] {
  return r.predictions.map((p, i) => (r.emptyReplies[i] === true ? 'keep' : p));
}

/** Collapse an item's N votes to one label. Ties / no-votes → keep (fail open). */
function predictedLabel(votes: Label[]): Label {
  const rejects = votes.filter((v) => v === 'reject').length;
  const keeps = votes.length - rejects;
  return rejects > keeps ? 'reject' : 'keep';
}

export function gateMetrics(items: GateItemResult[]): GateMetrics {
  let correct = 0;
  let tp = 0; // predicted reject & expected reject
  let fp = 0; // predicted reject & expected keep
  let fn = 0; // predicted keep   & expected reject
  let flipped = 0;
  let emptyCalls = 0;
  let totalCalls = 0;
  for (const it of items) {
    const votes = effectiveVotes(it);
    const pred = predictedLabel(votes);
    if (pred === it.expected) correct++;
    if (pred === 'reject' && it.expected === 'reject') tp++;
    if (pred === 'reject' && it.expected === 'keep') fp++;
    if (pred === 'keep' && it.expected === 'reject') fn++;
    if (new Set(votes).size > 1) flipped++;
    emptyCalls += it.emptyReplies.filter(Boolean).length;
    totalCalls += it.predictions.length;
  }
  // Empty denominators → 0: a gate that predicts no rejects has no demonstrated reject ability, and 0
  // is a stable, honest read of that (vs NaN). Same for rates over an empty set.
  const safe = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  return {
    accuracy: safe(correct, items.length),
    rejectPrecision: safe(tp, tp + fp),
    rejectRecall: safe(tp, tp + fn),
    flipRate: safe(flipped, items.length),
    emptyReplyRate: safe(emptyCalls, totalCalls),
  };
}
