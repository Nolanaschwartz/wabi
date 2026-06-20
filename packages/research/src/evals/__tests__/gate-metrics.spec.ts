import { gateMetrics, GateItemResult } from '../gate-metrics';

// Reject is the POSITIVE class for precision/recall — the gate's job is to throw out the irrelevant
// papers, so we measure how well it catches the ones that should be rejected.
//
// Each item carries N gate verdicts (`predictions`) and the per-call empty-reply flags aligned with
// them. An empty call counts as a `keep` vote (the gate fails open). `emptyReplies` defaults to all-
// false (no empty calls) for the common case.
const item = (
  expected: 'keep' | 'reject',
  predictions: ('keep' | 'reject')[],
  emptyReplies: boolean[] = predictions.map(() => false),
): GateItemResult => ({ expected, predictions, emptyReplies });

describe('gateMetrics', () => {
  it('all-correct → accuracy 1, reject precision/recall 1, no flips, no empties', () => {
    const m = gateMetrics([
      item('keep', ['keep']),
      item('reject', ['reject']),
      item('keep', ['keep']),
      item('reject', ['reject']),
    ]);
    expect(m.accuracy).toBe(1);
    expect(m.rejectPrecision).toBe(1);
    expect(m.rejectRecall).toBe(1);
    expect(m.flipRate).toBe(0);
    expect(m.emptyReplyRate).toBe(0);
  });

  it('a balanced confusion matrix → exact reject precision/recall/accuracy', () => {
    const m = gateMetrics([
      item('reject', ['reject']), // TP
      item('reject', ['keep']), //   FN
      item('keep', ['reject']), //   FP
      item('keep', ['keep']), //     TN
    ]);
    expect(m.accuracy).toBe(0.5);
    expect(m.rejectPrecision).toBe(0.5);
    expect(m.rejectRecall).toBe(0.5);
  });

  it('an empty reply counts as a keep vote (gate fails open)', () => {
    // Model text would say "reject", but both calls were empty/starved → production keeps it. The
    // expected-reject item becomes a miss (FN), not a catch.
    const m = gateMetrics([item('reject', ['reject', 'reject'], [true, true])]);
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
    expect(m.accuracy).toBe(0);
  });

  it('no reject predictions → reject precision 0', () => {
    const m = gateMetrics([item('keep', ['keep']), item('reject', ['keep'])]);
    expect(m.rejectPrecision).toBe(0);
    expect(m.rejectRecall).toBe(0);
    expect(m.accuracy).toBe(0.5);
  });

  it('flipRate = fraction of items whose N verdicts were not unanimous', () => {
    const m = gateMetrics([
      item('reject', ['reject', 'reject', 'reject']), // unanimous
      item('keep', ['keep', 'reject', 'keep']), //       flipped
    ]);
    expect(m.flipRate).toBe(0.5);
  });

  it('an empty reply makes a verdict non-unanimous (it votes keep)', () => {
    // reject, reject, but the 3rd call was empty → keep → not unanimous → a flip.
    const m = gateMetrics([item('reject', ['reject', 'reject', 'reject'], [false, false, true])]);
    expect(m.flipRate).toBe(1);
  });

  it('emptyReplyRate = fraction of CALLS that were empty (not items)', () => {
    // 2 items × 2 calls = 4 calls; 1 empty → 0.25.
    const m = gateMetrics([
      item('keep', ['keep', 'keep'], [false, true]),
      item('reject', ['reject', 'reject'], [false, false]),
    ]);
    expect(m.emptyReplyRate).toBe(0.25);
  });
});
