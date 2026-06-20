import { Injectable } from '@nestjs/common';
import { prisma, Prisma } from '@wabi/shared';
import { MemoryStoreService } from '../memory/memory-store.service';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { UserService } from '../user/user.service';
import { StripeService } from '../billing/stripe.service';

/**
 * Generate a Prisma-backed data source entry from a model name and field mapper. Pass the model's
 * row type as `Row` (e.g. `prismaSource<Prisma.MoodGetPayload<{}>>(...)`) so the mapper's field
 * access is checked against the real schema — a typo fails the build rather than silently exporting
 * `undefined`. The model accessor itself is dynamic (camelCased model name), hence the `any` casts.
 */
function prismaSource<Row>(
  key: string,
  model: Prisma.ModelName,
  mapFn: (row: Row) => Record<string, unknown>,
): UserDataSource {
  const modelCamel = model.charAt(0).toLowerCase() + model.slice(1);
  return {
    key,
    model,
    read: (id: string) =>
      (prisma as any)[modelCamel]
        .findMany({ where: { userId: id } })
        .then((rows: Row[]) => rows.map(mapFn)),
    delTx: (tx: Prisma.TransactionClient, id: string) =>
      (tx as any)[modelCamel].deleteMany({ where: { userId: id } }),
  };
}

/**
 * One source of a person's data. The whole point of declaring these in a single list is that
 * `export()` and `delete()` both derive from it — so the two can never drift, and adding a new
 * store is a single entry touched by both paths.
 *
 * (A prior gap proved why this matters: CoachingSession was missing from both hand-maintained
 * lists, so a `/data delete` silently orphaned it — ADR-0004/0011 say a person can always fully
 * delete their data. A completeness test now asserts every userId-bearing Prisma model is covered.)
 */
interface UserDataSource {
  /** Export key. Omit for delete-only sources — internal bookkeeping we reap but never surface. */
  key?: string;
  /** The Prisma model this source deletes (for the completeness check). Omit for external stores. */
  model?: Prisma.ModelName;
  /** Human label for a delete-failure message (external stores with no model/key). */
  label?: string;
  /** Export reader, shaped exactly as the user-facing JSON. Omit ⇒ not exported. */
  read?: (discordId: string) => Promise<unknown>;
  /** Delete inside the atomic Prisma transaction. */
  delTx?: (tx: Prisma.TransactionClient, discordId: string) => Promise<unknown>;
  /** Delete outside the transaction — a different store (e.g. Mem0, Redis). */
  delExternal?: (discordId: string) => Promise<unknown>;
}

@Injectable()
export class DataRightsService {
  private readonly sources: UserDataSource[];

  constructor(
    private readonly userService: UserService,
    private readonly memoryStore: MemoryStoreService,
    private readonly sessionBuffer: SessionBufferService,
    private readonly stripe: StripeService,
  ) {
    this.sources = [
      prismaSource<Prisma.MoodGetPayload<{}>>('moods', 'Mood', (m) => ({
        rating: m.rating,
        emoji: m.emoji,
        note: m.note,
        createdAt: m.createdAt,
      })),
      prismaSource<Prisma.PlaytimeLogGetPayload<{}>>('playtime', 'PlaytimeLog', (p) => ({
        duration: p.duration,
        game: p.game,
        createdAt: p.createdAt,
      })),
      prismaSource<Prisma.JournalEntryGetPayload<{}>>('journal', 'JournalEntry', (j) => ({
        content: j.content,
        reflection: j.reflection,
        createdAt: j.createdAt,
      })),
      prismaSource<Prisma.XpEntryGetPayload<{}>>('xp', 'XpEntry', (x) => ({
        amount: x.amount,
        reason: x.reason,
        createdAt: x.createdAt,
      })),
      prismaSource<Prisma.EscalationEventGetPayload<{}>>('escalations', 'EscalationEvent', (e) => ({
        layer: e.layer,
        timestamp: e.timestamp,
      })),
      prismaSource<Prisma.SessionGetPayload<{}>>('sessions', 'Session', (s) => ({
        sessionId: s.id,
        expiresAt: s.expiresAt,
      })),
      prismaSource<Prisma.TiltSessionGetPayload<{}>>('tilt', 'TiltSession', (t) => ({
        trigger: t.trigger,
        severity: t.severity,
        technique: t.technique,
        resolved: t.resolved,
        createdAt: t.createdAt,
      })),
      prismaSource<Prisma.AiConversationGetPayload<{}>>('conversations', 'AiConversation', (c) => ({
        topic: c.topic,
        createdAt: c.createdAt,
      })),
      {
        // Delete-only. The Coaching Session row is internal bookkeeping (lastActivity, mined,
        // doNotMine) with no user-authored content — reaped on delete, never surfaced in export.
        // Keyed by discordId with no User FK, so onDelete: Cascade can't reach it; it must be
        // explicit. This is the row that was previously orphaned.
        model: 'CoachingSession',
        delTx: (tx, id) => tx.coachingSession.deleteMany({ where: { discordId: id } }),
      },
      {
        key: 'memory',
        label: 'mem0',
        read: (id) =>
          this.memoryStore.getAllForUser(id).then((rows) =>
            rows.map((m) => ({ id: m.id, content: m.content })),
          ),
        delExternal: (id) => this.memoryStore.deleteAllForUser(id),
      },
      {
        // Delete-only, external (Redis). The session buffer holds verbatim turns + the quarantine
        // key — they must be purged immediately on delete, not left to TTL (ADR-0011).
        label: 'redis-session',
        delExternal: (id) => this.sessionBuffer.purge(id),
      },
    ];
  }

  /** The Prisma models the delete path covers — asserted complete against the schema in a test. */
  coveredModels(): Prisma.ModelName[] {
    return this.sources
      .map((s) => s.model)
      .filter((m): m is Prisma.ModelName => m != null);
  }

  /**
   * The models the account-deletion path removes: the child-data sources plus the User identity row
   * (deleted directly in `deleteAccount`). Asserted complete against the schema in a test.
   */
  accountCoveredModels(): Prisma.ModelName[] {
    return [...this.coveredModels(), 'User'];
  }

  async export(discordId: string): Promise<string> {
    const exportable = this.sources.filter((s) => s.key && s.read);

    const [user, entries] = await Promise.all([
      this.userService.findByDiscordId(discordId),
      Promise.all(exportable.map(async (s) => [s.key!, await s.read!(discordId)] as const)),
    ]);

    const data = {
      user: {
        discordId: user?.discordId,
        email: user?.email,
        locale: user?.locale,
        createdAt: user?.createdAt,
      },
      ...Object.fromEntries(entries),
    };

    return JSON.stringify(data, null, 2);
  }

  async delete(discordId: string): Promise<void> {
    await this.eraseAllData(discordId, false);
  }

  /**
   * The shared erase: an atomic Postgres tx deleting every child-data source (optionally the User
   * identity row too), then a best-effort external-store purge.
   *
   * The in-tx deletes are atomic: a failure rolls back and PROPAGATES. Data Rights are
   * unconditional (ADR-0011), so a silently-swallowed partial delete is the wrong failure mode —
   * the caller must learn it didn't fully complete. Removing the User row (when `alsoDeleteUser`)
   * cascades to the lucia Session rows (Session.userId -> User.id, onDelete: Cascade), invalidating
   * the web session server-side.
   */
  private async eraseAllData(discordId: string, alsoDeleteUser: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
      for (const s of this.sources) {
        if (s.delTx) await s.delTx(tx, discordId);
      }
      if (alsoDeleteUser) {
        await tx.user.deleteMany({ where: { discordId } });
      }
    });

    await this.purgeExternalStores(discordId);
  }

  /**
   * Delete the person's account entirely: cancel billing, erase all data AND the User identity row,
   * then purge external stores. Ordering fails toward "not billing, not orphaned":
   *
   *   1. Cancel + delete the Stripe customer FIRST. A failure here aborts with nothing deleted — the
   *      person stays fully intact rather than erased-but-still-billed. (No customer / unconfigured
   *      Stripe is a graceful no-op, not a failure — see StripeService.)
   *   2. Atomic Postgres tx: the same child-data deletes as `delete()`, PLUS the User row. Removing
   *      the User row cascades to the lucia Session rows (Session.userId -> User.id, onDelete:
   *      Cascade), invalidating the web session server-side.
   *   3. Best-effort external purge (Mem0, Redis), surfacing any store left behind.
   *
   * Unlike `delete()`, this does NOT keep the account — it is the "delete my account" path.
   */
  async deleteAccount(discordId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { discordId },
      select: { stripeCustomerId: true },
    });
    await this.stripe.deleteCustomer(user?.stripeCustomerId);

    await this.eraseAllData(discordId, true);
  }

  /**
   * Delete the external (non-Postgres) stores after the tx commits. Attempt every one even if an
   * earlier fails, then surface which stores were left behind so the caller never reports a clean
   * deletion that wasn't (ADR-0011).
   */
  private async purgeExternalStores(discordId: string): Promise<void> {
    const failures: string[] = [];
    for (const s of this.sources) {
      if (!s.delExternal) continue;
      try {
        await s.delExternal(discordId);
      } catch {
        failures.push(s.label ?? s.key ?? s.model ?? 'external');
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Data deletion incomplete; external stores failed: ${failures.join(', ')}`,
      );
    }
  }
}
