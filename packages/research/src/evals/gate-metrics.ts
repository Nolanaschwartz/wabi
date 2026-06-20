/**
 * Pure quality + trust metrics for the relevance gate, scored against an independent intent rubric
 * (ADR-0040). No I/O — the eval scripts feed it the per-item results and print what it returns.
 *
 * Reject is the POSITIVE class: the gate exists to discard irrelevant papers, so precision/recall
 * measure how well it catches the rejects. The gate fails OPEN (empty/uncertain → keep), and the
 * metrics mirror that exactly so an audit reflects production behaviour, not an idealised gate.
 *
 * Three kinds of per-call outcome, kept distinct so a broken provider can't masquerade as quality:
 *   - a normal verdict (keep/reject) — a real vote.
 *   - an EMPTY reply: the call RAN but returned no usable text → counts as a keep vote (fail open)
 *     and into emptyReplyRate.
 *   - a FAILED call: it threw / never ran (provider down, 401, transport) → NOT a vote. Excluded from
 *     accuracy/precision/recall/flip entirely; it only feeds failureRate. An item whose calls ALL
 *     failed is "unscored" and drops out of the quality metrics, so a partial outage cannot silently
 *     drag accuracy toward fail-open keeps.
 *
 * Trust metrics: flipRate = fraction of SCORED items whose surviving verdicts were not unanimous (the
 * gate's determinism is only asserted, not proven); emptyReplyRate = empties / calls-that-ran;
 * failureRate = failed / all calls (the outage signal).
 */
export type Label = 'keep' | 'reject';

export interface GateItemResult {
  /** Ground truth from the intent rubric. */
  expected: Label;
  /** One verdict per gate run (N≥1). Collapsed by majority vote over surviving votes, ties → keep. */
  predictions: Label[];
  /** Per-call empty-reply flags, aligned with `predictions`. An empty call counts as a keep vote. */
  emptyReplies: boolean[];
  /** Per-call failure flags, aligned with `predictions`. A failed call is excluded from the votes. */
  failures: boolean[];
}

export interface GateMetrics {
  accuracy: number;
  rejectPrecision: number;
  rejectRecall: number;
  flipRate: number;
  emptyReplyRate: number;
  failureRate: number;
}

/** Collapse votes to one label. Ties / no-votes → keep (fail open). */
function predictedLabel(votes: Label[]): Label {
  const rejects = votes.filter((v) => v === 'reject').length;
  return rejects > votes.length - rejects ? 'reject' : 'keep';
}

export function gateMetrics(items: GateItemResult[]): GateMetrics {
  let scored = 0; // items with ≥1 surviving (non-failed) vote
  let correct = 0;
  let tp = 0; // predicted reject & expected reject
  let fp = 0; // predicted reject & expected keep
  let fn = 0; // predicted keep   & expected reject
  let flipped = 0;
  let emptyRan = 0;
  let ranCalls = 0;
  let failedCalls = 0;
  let totalCalls = 0;
  for (const it of items) {
    const votes: Label[] = [];
    it.predictions.forEach((p, i) => {
      totalCalls++;
      if (it.failures[i] === true) {
        failedCalls++;
        return; // a failed call never ran — not a vote
      }
      ranCalls++;
      const empty = it.emptyReplies[i] === true;
      if (empty) emptyRan++;
      votes.push(empty ? 'keep' : p); // empty → keep (fail open)
    });
    if (votes.length === 0) continue; // unscored: all calls failed
    scored++;
    const pred = predictedLabel(votes);
    if (pred === it.expected) correct++;
    if (pred === 'reject' && it.expected === 'reject') tp++;
    if (pred === 'reject' && it.expected === 'keep') fp++;
    if (pred === 'keep' && it.expected === 'reject') fn++;
    if (new Set(votes).size > 1) flipped++;
  }
  // Empty denominators → 0: no scored items / no rejects predicted / no calls → 0 is a stable, honest
  // read (vs NaN). accuracy over zero scored items is 0, not a phantom pass.
  const safe = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  return {
    accuracy: safe(correct, scored),
    rejectPrecision: safe(tp, tp + fp),
    rejectRecall: safe(tp, tp + fn),
    flipRate: safe(flipped, scored),
    emptyReplyRate: safe(emptyRan, ranCalls),
    failureRate: safe(failedCalls, totalCalls),
  };
}
