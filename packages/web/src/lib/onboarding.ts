/**
 * Onboarding module — the web-first identity → consented User → Trial lifecycle.
 *
 * This is the highest-stakes write in web: the first-ever `User.create`, which must not
 * happen before explicit consent (ADR-0002/0015) and must stamp the Trial (ADR-0011).
 * The two functions below are the *brain*; the routes are thin adapters that parse the
 * request, do the Discord OAuth code exchange, and set cookies. The module is
 * transport-agnostic — it returns a decision/userId and never touches `NextResponse`,
 * `cookies`, or Discord HTTP — so it is unit-tested through this interface rather than
 * through a route with `NextRequest`/`global.fetch`/`set-cookie` ceremony.
 *
 * The Trial window/status come from `@wabi/shared`'s `trialGrant` (the single decision
 * the bot and web share) — this module orchestrates the write, it never re-decides.
 * The store is reached through a narrow injected `OnboardingWriter` seam: prod passes
 * `prisma`; tests pass an in-memory double.
 */
import { trialGrant } from '@wabi/shared';
import {
  createPendingConsentToken,
  verifyPendingConsentToken,
} from '@/lib/pending-consent';

export type VerifiedIdentity = { discordId: string; email: string | null };

export type Resolution =
  | { kind: 'existing'; userId: string } // already a consented User → sign straight in
  | { kind: 'pending'; token: string }; //  new identity → hold in a signed cookie, no write

/** Only the slice of the Prisma client this module needs — the seam tests substitute. */
export interface OnboardingWriter {
  user: {
    findUnique(args: { where: { discordId: string } }): Promise<{ id: string } | null>;
    upsert(args: {
      where: { discordId: string };
      update: { consentAcceptedAt: Date };
      create: {
        discordId: string;
        email: string | null;
        consentAcceptedAt: Date;
        trialEndsAt: Date;
        subscriptionStatus: string;
      };
    }): Promise<{ id: string }>;
  };
}

/**
 * The callback's brain. A known identity signs straight in (no write); an unknown one
 * gets a signed pending-consent token to carry to the consent step. Performs no write
 * in either branch — the first persistence is deferred to {@link provisionConsentedUser}.
 */
export async function resolveOrPend(
  db: OnboardingWriter,
  identity: VerifiedIdentity,
  now: Date,
): Promise<Resolution> {
  const existing = await db.user.findUnique({ where: { discordId: identity.discordId } });
  if (existing) {
    return { kind: 'existing', userId: existing.id };
  }
  const token = createPendingConsentToken(identity.discordId, identity.email, now.getTime());
  return { kind: 'pending', token };
}

/**
 * The consent step's brain and the ONLY path that creates a `User` in web. Returns
 * `null` (→ 401) when the pending-consent token is missing, forged, or expired, and
 * writes nothing in that case. On a valid token it upserts — keyed on `discordId`, so a
 * retried consent (cookie still valid) is idempotent.
 *
 * The Trial is granted on CREATE only. The update branch refreshes `consentAcceptedAt`
 * but never re-stamps `trialEndsAt`/`subscriptionStatus`: a replayed consent POST for an
 * existing User (back/refresh, or the success cookie-clear never landing) must not extend
 * the trial or reset an already-converted subscriber back to 'trialing' (billing state is
 * Stripe's, ADR-0011) — that would let a user renew their trial indefinitely.
 */
export async function provisionConsentedUser(
  db: OnboardingWriter,
  token: string | undefined,
  now: Date,
): Promise<{ userId: string } | null> {
  const pending = verifyPendingConsentToken(token, now.getTime());
  if (!pending) {
    return null;
  }

  const { trialEndsAt, subscriptionStatus } = trialGrant(now);
  const user = await db.user.upsert({
    where: { discordId: pending.discordId },
    update: { consentAcceptedAt: now },
    create: {
      discordId: pending.discordId,
      email: pending.email,
      consentAcceptedAt: now,
      trialEndsAt,
      subscriptionStatus,
    },
  });
  return { userId: user.id };
}
