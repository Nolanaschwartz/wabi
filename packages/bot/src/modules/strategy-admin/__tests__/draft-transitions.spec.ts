import { nextStatus } from '../draft-transitions';

describe('nextStatus — the legal Strategy Draft status graph (ADR-0012)', () => {
  it('pending-review → approve → published', () => {
    expect(nextStatus('pending-review', 'approve')).toBe('published');
  });

  it('pending-review → reject → quarantined', () => {
    expect(nextStatus('pending-review', 'reject')).toBe('quarantined');
  });

  it('published → demote → quarantined', () => {
    expect(nextStatus('published', 'demote')).toBe('quarantined');
  });

  it('rejects approving an already-published draft', () => {
    expect(nextStatus('published', 'approve')).toBeNull();
  });

  it('rejects rejecting an already-published draft', () => {
    expect(nextStatus('published', 'reject')).toBeNull();
  });

  it('rejects demoting a pending-review draft', () => {
    expect(nextStatus('pending-review', 'demote')).toBeNull();
  });

  it('rejects every action on a quarantined draft (terminal)', () => {
    expect(nextStatus('quarantined', 'approve')).toBeNull();
    expect(nextStatus('quarantined', 'reject')).toBeNull();
    expect(nextStatus('quarantined', 'demote')).toBeNull();
  });

  it('rejects an unknown current status', () => {
    expect(nextStatus('draft', 'approve')).toBeNull();
  });
});
