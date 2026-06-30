import { completeOnboarding, type ProfileWriter } from '../onboarding-profile';

/** In-memory ProfileWriter double — records update calls; returns a fixed id. */
function writer() {
  const calls = { update: [] as any[] };
  const db: ProfileWriter = {
    user: {
      update: async (args) => {
        calls.update.push(args);
        return { id: args.where.id };
      },
    },
  };
  return { db, calls };
}

const now = new Date('2026-06-29T00:00:00Z');

describe('completeOnboarding', () => {
  it('writes the personalization columns and stamps onboardingCompletedAt', async () => {
    const { db, calls } = writer();
    const r = await completeOnboarding(
      db,
      'u1',
      { locale: 'en-GB', timezone: 'Europe/London', improveAreas: ['tilt', 'sleep'], interests: ['fps'] },
      now,
    );
    expect(r).toEqual({ ok: true });
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toEqual({
      where: { id: 'u1' },
      data: {
        locale: 'en-GB',
        timezone: 'Europe/London',
        improveAreas: ['tilt', 'sleep'],
        interests: ['fps'],
        onboardingCompletedAt: now,
      },
    });
  });

  it('rejects and writes nothing when no valid Improvement Area is given', async () => {
    const { db, calls } = writer();
    const r = await completeOnboarding(
      db,
      'u1',
      { locale: 'en-US', timezone: 'UTC', improveAreas: [], interests: ['fps'] },
      now,
    );
    expect(r.ok).toBe('invalid');
    expect(calls.update).toHaveLength(0);
  });

  it('drops unknown area and interest slugs, persisting only the valid subset', async () => {
    const { db, calls } = writer();
    const r = await completeOnboarding(
      db,
      'u1',
      { locale: 'en-US', timezone: 'UTC', improveAreas: ['tilt', 'bogus'], interests: ['fps', 'nope'] },
      now,
    );
    expect(r).toEqual({ ok: true });
    expect(calls.update[0].data.improveAreas).toEqual(['tilt']);
    expect(calls.update[0].data.interests).toEqual(['fps']);
  });

  it('rejects when every area slug is unknown (no valid area survives)', async () => {
    const { db, calls } = writer();
    const r = await completeOnboarding(
      db,
      'u1',
      { locale: 'en-US', timezone: 'UTC', improveAreas: ['bogus'], interests: [] },
      now,
    );
    expect(r.ok).toBe('invalid');
    expect(calls.update).toHaveLength(0);
  });

  it('never writes trial or billing fields', async () => {
    const { db, calls } = writer();
    await completeOnboarding(
      db,
      'u1',
      { locale: 'en-US', timezone: 'UTC', improveAreas: ['focus'], interests: [] },
      now,
    );
    const data = calls.update[0].data;
    expect(data).not.toHaveProperty('trialEndsAt');
    expect(data).not.toHaveProperty('subscriptionStatus');
    expect(data).not.toHaveProperty('consentAcceptedAt');
  });
});
