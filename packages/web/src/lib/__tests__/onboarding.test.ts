import {
  resolveOrPend,
  provisionConsentedUser,
  type OnboardingWriter,
} from '../onboarding';
import { createPendingConsentToken } from '../pending-consent';

const DAY_MS = 86_400_000;

/** In-memory OnboardingWriter double — records upsert calls; returns a fixed new id. */
function writer(existing: { id: string } | null = null) {
  const calls = { upsert: [] as any[] };
  const db: OnboardingWriter = {
    user: {
      findUnique: async () => existing,
      upsert: async (args) => {
        calls.upsert.push(args);
        return { id: 'new-user' };
      },
    },
  };
  return { db, calls };
}

describe('onboarding module', () => {
  beforeEach(() => {
    process.env.LUCIA_SECRET = 'test-secret-for-signing';
    process.env.TRIAL_DAYS = '7';
  });

  describe('resolveOrPend', () => {
    it('signs an existing User straight in and writes nothing', async () => {
      const { db, calls } = writer({ id: 'u1' });
      const r = await resolveOrPend(db, { discordId: 'd', email: null }, new Date());
      expect(r).toEqual({ kind: 'existing', userId: 'u1' });
      expect(calls.upsert).toHaveLength(0);
    });

    it('mints a pending-consent token for a new identity and writes nothing', async () => {
      const { db, calls } = writer(null);
      const r = await resolveOrPend(db, { discordId: 'd', email: 'g@x.com' }, new Date());
      expect(r.kind).toBe('pending');
      if (r.kind === 'pending') expect(typeof r.token).toBe('string');
      expect(calls.upsert).toHaveLength(0);
    });
  });

  describe('provisionConsentedUser', () => {
    const now = new Date('2026-06-01T00:00:00Z');

    it('returns null and writes nothing without a token', async () => {
      const { db, calls } = writer();
      expect(await provisionConsentedUser(db, undefined, now)).toBeNull();
      expect(calls.upsert).toHaveLength(0);
    });

    it('returns null and writes nothing for a tampered token', async () => {
      const { db, calls } = writer();
      expect(await provisionConsentedUser(db, 'forged-payload.forged-sig', now)).toBeNull();
      expect(calls.upsert).toHaveLength(0);
    });

    it('returns null for an expired token', async () => {
      const { db, calls } = writer();
      // issued 16 minutes ago — past the 15-minute consent window.
      const stale = createPendingConsentToken('d', null, now.getTime() - 16 * 60 * 1000);
      expect(await provisionConsentedUser(db, stale, now)).toBeNull();
      expect(calls.upsert).toHaveLength(0);
    });

    it('creates the User + Trial on a valid token, stamping consent at now', async () => {
      const { db, calls } = writer();
      const token = createPendingConsentToken('discord-123', 'g@x.com', now.getTime());

      const r = await provisionConsentedUser(db, token, now);

      expect(r).toEqual({ userId: 'new-user' });
      const args = calls.upsert[0];
      expect(args.where).toEqual({ discordId: 'discord-123' });
      expect(args.create.discordId).toBe('discord-123');
      expect(args.create.email).toBe('g@x.com');
      expect(args.create.consentAcceptedAt).toEqual(now);
      expect(args.create.subscriptionStatus).toBe('trialing');
      expect(args.create.trialEndsAt.getTime()).toBe(now.getTime() + 7 * DAY_MS);
      // The Trial is a CREATE-only grant. The update branch only refreshes consent — it must
      // never carry trialEndsAt/subscriptionStatus, or a replayed consent re-grants the trial.
      expect(args.update).toEqual({ consentAcceptedAt: now });
    });

    it('is idempotent — a retried valid token upserts the same discordId', async () => {
      const { db, calls } = writer();
      const token = createPendingConsentToken('discord-123', null, now.getTime());

      await provisionConsentedUser(db, token, now);
      await provisionConsentedUser(db, token, now);

      expect(calls.upsert).toHaveLength(2);
      expect(calls.upsert[0].where).toEqual({ discordId: 'discord-123' });
      expect(calls.upsert[1].where).toEqual({ discordId: 'discord-123' });
    });

    it('a replayed consent for an EXISTING User does not re-grant the trial or reset billing', async () => {
      // Prisma resolves the update branch when the row exists; the upsert args carry both branches,
      // so assert the update branch is consent-only (no trialEndsAt, no subscriptionStatus).
      const { db, calls } = writer({ id: 'existing' });
      const token = createPendingConsentToken('discord-123', null, now.getTime());

      await provisionConsentedUser(db, token, now);

      const args = calls.upsert[0];
      expect(args.update).toEqual({ consentAcceptedAt: now });
      expect(args.update.trialEndsAt).toBeUndefined();
      expect(args.update.subscriptionStatus).toBeUndefined();
    });
  });
});
