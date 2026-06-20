/**
 * Pure quality metrics for the relevance gate, scored against an independent intent rubric
 * (ADR-0040). No I/O — the eval scripts feed it the per-item results and print what it returns.
 *
 * Reject is the POSITIVE class: the gate exists to discard irrelevant papers, so precision/recall
 * measure how well it catches the rejects. The gate fails OPEN (empty/uncertain → keep), and the
 * metrics mirror that exactly so an audit reflects production behaviour, not an idealised gate.
 *
 * Trust metrics (flip-rate, empty-reply-rate over N runs) arrive in slice 2; `predictions` is already
 * an array per item so that layer drops in without changing this interface.
 */
export type Label = 'keep' | 'reject';

export interface GateItemResult {
  /** Ground truth from the intent rubric. */
  expected: Label;
  /** One label per gate run (N≥1). Collapsed by majority vote, ties → keep (fail open). */
  predictions: Label[];
  /** The gate returned no usable text on this item. Production keeps it, so we score it as keep. */
  emptyReply: boolean;
}

export interface GateMetrics {
  accuracy: number;
  rejectPrecision: number;
  rejectRecall: number;
}

/** Collapse an item's N predictions to one label. Empty reply → keep; ties/no-votes → keep. */
function predictedLabel(r: GateItemResult): Label {
  if (r.emptyReply) return 'keep';
  const rejects = r.predictions.filter((p) => p === 'reject').length;
  const keeps = r.predictions.length - rejects;
  return rejects > keeps ? 'reject' : 'keep';
}

export function gateMetrics(items: GateItemResult[]): GateMetrics {
  let correct = 0;
  let tp = 0; // predicted reject & expected reject
  let fp = 0; // predicted reject & expected keep
  let fn = 0; // predicted keep   & expected reject
  for (const it of items) {
    const pred = predictedLabel(it);
    if (pred === it.expected) correct++;
    if (pred === 'reject' && it.expected === 'reject') tp++;
    if (pred === 'reject' && it.expected === 'keep') fp++;
    if (pred === 'keep' && it.expected === 'reject') fn++;
  }
  // Empty denominators → 0: a gate that predicts no rejects has no demonstrated reject ability, and 0
  // is a stable, honest read of that (vs NaN). accuracy over an empty set is 0 by the same token.
  const safe = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  return {
    accuracy: safe(correct, items.length),
    rejectPrecision: safe(tp, tp + fp),
    rejectRecall: safe(tp, tp + fn),
  };
}
