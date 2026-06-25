import { Injectable } from '@nestjs/common';
import { prisma, Prisma } from '@wabi/shared';
import { DraftAction, nextStatus } from './draft-transitions';

export type StrategyDraftRow = Prisma.StrategyDraftGetPayload<{}>;

/**
 * Owns the Strategy Draft status lifecycle (ADR-0012): read current → guard the transition
 * (`draft-transitions`) → optional precommit gate → atomic status write. It deliberately does NOT touch
 * the Qdrant index — the caller owns index ordering, which differs per action: `approve` indexes
 * BEFORE the status write (via `precommit`, so a published Draft is always retrievable), while
 * `reject`/`demote` delete from the index AFTER a non-null result. Returns the updated row, or null when
 * the draft is missing, the transition is illegal, the precommit vetoes, or the write fails.
 *
 * `applyDemote` (the durable-job tail of negative-feedback) is intentionally NOT routed through here: it
 * is downstream of `recordNegativeFeedback`'s own `published` guard and also resets `negativeCount`, so
 * it is a counter-reset + write, not a pure status transition.
 */
@Injectable()
export class StrategyDraftStateMachine {
  async transition(
    id: string,
    action: DraftAction,
    opts?: { precommit?: (draft: StrategyDraftRow) => Promise<boolean> },
  ): Promise<StrategyDraftRow | null> {
    const existing = await prisma.strategyDraft.findUnique({ where: { id } });
    if (!existing) return null;

    const next = nextStatus(existing.status, action);
    if (!next) return null;

    // Index-first actions gate the status write on a successful precommit (the Qdrant upsert for
    // approve), so the index can never silently lag Postgres; a vetoed precommit leaves the status
    // unchanged (ADR-0012).
    if (opts?.precommit && !(await opts.precommit(existing))) return null;

    return prisma.strategyDraft
      .update({ where: { id }, data: { status: next } })
      .catch(() => null);
  }
}
