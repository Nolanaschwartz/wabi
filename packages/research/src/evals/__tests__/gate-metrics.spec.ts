import { gateMetrics, GateItemResult } from '../gate-metrics';

// Reject is the POSITIVE class for precision/recall — the gate's job is to throw out the irrelevant
// papers, so we measure how well it catches the ones that should be rejected.
//
// Each item carries N gate verdicts (`predictions`) plus, aligned with them, the per-call empty-reply
// and failure flags. An empty call (RAN but returned no usable text) counts as a `keep` vote. A failed
// call (threw / never ran — provider down) is NOT a vote at all: it is excluded from the quality
// metrics and only feeds failureRate. Both flag arrays default to all-false.
const item = (
  expected: 'keep' | 'reject',
  predictions: ('keep' | 'reject')[],
  emptyReplies: boolean[] = predictions.map(() => false),
  failures: boolean[] = predictions.map(() => false),
): GateItemResult => ({ expected, predictions, emptyReplies, failures });

describe('gateMetrics', () => {
  it('all-correct → accuracy 1, reject precision/recall 1, no flips/empties/failures', () => {
    const m = gateMetrics([
      item('keep', ['keep']),
      item('reject', ['reject']),
      item('keep', ['keep']),
      item('reject', ['reject']),
    ]);
    expect(m).toEqual({ accuracy: 1, rejectPrecision: 1, rejectRecall: 1, flipRate: 0, emptyReplyRate: 0, failureRate: 0 });
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

  it('an empty reply counts as a keep vote, and into emptyReplyRate (not failureRate)', () => {
    const m = gateMetrics([item('reject', ['reject', 'reject'], [true, true])]);
    expect(m.accuracy).toBe(0); // both votes keep → miss the reject
    expect(m.rejectRecall).toBe(0);
    expect(m.emptyReplyRate).toBe(1);
    expect(m.failureRate).toBe(0);
  });

  it('majority vote collapses N predictions per item', () => {
    const m = gateMetrics([
      item('reject', ['reject', 'reject', 'keep']),
      item('keep', ['reject', 'keep', 'keep']),
    ]);
    expect(m.accuracy).toBe(1);
  });

  it('a tie breaks to keep (fail open)', () => {
    expect(gateMetrics([item('reject', ['reject', 'keep'])]).accuracy).toBe(0);
  });

  it('no reject predictions → reject precision 0', () => {
    const m = gateMetrics([item('keep', ['keep']), item('reject', ['keep'])]);
    expect(m.rejectPrecision).toBe(0);
    expect(m.rejectRecall).toBe(0);
    expect(m.accuracy).toBe(0.5);
  });

  it('flipRate = fraction of SCORED items whose surviving verdicts were not unanimous', () => {
    const m = gateMetrics([
      item('reject', ['reject', 'reject', 'reject']),
      item('keep', ['keep', 'reject', 'keep']),
    ]);
    expect(m.flipRate).toBe(0.5);
  });

  it('an empty reply makes a verdict non-unanimous (it votes keep)', () => {
    const m = gateMetrics([item('reject', ['reject', 'reject', 'reject'], [false, false, true])]);
    expect(m.flipRate).toBe(1);
  });

  it('emptyReplyRate = empties / calls that RAN (failed calls excluded from the denominator)', () => {
    const m = gateMetrics([
      item('keep', ['keep', 'keep'], [false, true], [false, false]), // 2 ran, 1 empty
      item('reject', ['reject', 'reject'], [false, false], [false, true]), // 1 ran (1 failed), 0 empty
    ]);
    expect(m.emptyReplyRate).toBe(1 / 3); // 1 empty over 3 ran calls
  });

  // --- failures: a provider-down call must NOT leak in as a keep vote ---

  it('a failed call is excluded from the votes, not counted as keep', () => {
    // First call failed (threw); only the second ("reject") is a real vote → caught as reject.
    const m = gateMetrics([item('reject', ['keep', 'reject'], [false, false], [true, false])]);
    expect(m.accuracy).toBe(1); // scored on the one surviving reject vote
    expect(m.rejectRecall).toBe(1);
    expect(m.failureRate).toBe(0.5); // 1 of 2 calls failed
  });

  it('an all-failed item is unscored (out of accuracy), only feeding failureRate', () => {
    const m = gateMetrics([item('reject', ['keep'], [false], [true])]);
    expect(m.accuracy).toBe(0); // no scored items → safe 0, NOT a phantom keep
    expect(m.rejectRecall).toBe(0);
    expect(m.flipRate).toBe(0);
    expect(m.failureRate).toBe(1);
  });

  it('failureRate spans all items; a partial outage does not corrupt accuracy', () => {
    const m = gateMetrics([
      item('reject', ['reject']), // scored, correct
      item('keep', ['keep'], [false], [true]), // all-failed → unscored
    ]);
    expect(m.accuracy).toBe(1); // only the one scored item counts → still correct
    expect(m.failureRate).toBe(0.5);
  });
});
