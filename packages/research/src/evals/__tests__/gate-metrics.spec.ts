import { gateMetrics, GateItemResult } from '../gate-metrics';

// Reject is the POSITIVE class for precision/recall — the gate's job is to throw out the irrelevant
// papers, so we measure how well it catches the ones that should be rejected.
const item = (
  expected: 'keep' | 'reject',
  predictions: ('keep' | 'reject')[],
  emptyReply = false,
): GateItemResult => ({ expected, predictions, emptyReply });

describe('gateMetrics', () => {
  it('all-correct → accuracy 1, reject precision/recall 1', () => {
    const m = gateMetrics([
      item('keep', ['keep']),
      item('reject', ['reject']),
      item('keep', ['keep']),
      item('reject', ['reject']),
    ]);
    expect(m.accuracy).toBe(1);
    expect(m.rejectPrecision).toBe(1);
    expect(m.rejectRecall).toBe(1);
  });

  it('a balanced confusion matrix → exact reject precision/recall/accuracy', () => {
    // TP, FN, FP, TN — one of each (reject = positive).
    const m = gateMetrics([
      item('reject', ['reject']), // TP
      item('reject', ['keep']), //   FN
      item('keep', ['reject']), //   FP
      item('keep', ['keep']), //     TN
    ]);
    expect(m.accuracy).toBe(0.5); // (TP+TN)/4
    expect(m.rejectPrecision).toBe(0.5); // TP/(TP+FP)
    expect(m.rejectRecall).toBe(0.5); // TP/(TP+FN)
  });

  it('an empty reply counts as a keep prediction (gate fails open)', () => {
    // Model text would say "reject", but the reply was empty/starved → production keeps it. The metric
    // must score it as a keep, so this expected-reject item becomes a miss (FN), not a catch.
    const m = gateMetrics([item('reject', ['reject'], /* emptyReply */ true)]);
    expect(m.accuracy).toBe(0);
    expect(m.rejectRecall).toBe(0);
  });

  it('majority vote collapses N predictions per item', () => {
    const m = gateMetrics([
      item('reject', ['reject', 'reject', 'keep']), // majority reject → TP
      item('keep', ['reject', 'keep', 'keep']), //    majority keep   → TN
    ]);
    expect(m.accuracy).toBe(1);
    expect(m.rejectPrecision).toBe(1);
    expect(m.rejectRecall).toBe(1);
  });

  it('a tie breaks to keep (fail open)', () => {
    const m = gateMetrics([item('reject', ['reject', 'keep'])]);
    expect(m.accuracy).toBe(0); // tie → keep → misses the reject
  });

  it('no reject predictions → reject precision 0 (no positives to be precise about)', () => {
    const m = gateMetrics([item('keep', ['keep']), item('reject', ['keep'])]);
    expect(m.rejectPrecision).toBe(0);
    expect(m.rejectRecall).toBe(0);
    expect(m.accuracy).toBe(0.5);
  });
});
