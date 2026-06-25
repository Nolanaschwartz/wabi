/**
 * The legal Strategy Draft status graph in one place (ADR-0012 lifecycle). A Draft moves
 * pending-review → published (approve) | quarantined (reject), and published → quarantined (demote).
 * Any other (current, action) pair is illegal and yields null — the guard the operator methods used to
 * copy inline (`status !== 'pending-review'` / `!== 'published'`). Pure: no I/O, so it is its own test
 * surface.
 */
export type DraftStatus = 'pending-review' | 'published' | 'quarantined';
export type DraftAction = 'approve' | 'reject' | 'demote';

const TRANSITIONS: Record<DraftStatus, Partial<Record<DraftAction, DraftStatus>>> = {
  'pending-review': { approve: 'published', reject: 'quarantined' },
  published: { demote: 'quarantined' },
  quarantined: {},
};

/** The status a Draft moves to, or null if the transition is illegal (or the current status unknown). */
export function nextStatus(current: string, action: DraftAction): DraftStatus | null {
  return TRANSITIONS[current as DraftStatus]?.[action] ?? null;
}
