import { ContactPolicyService } from '../contact-policy.service';

describe('ContactPolicyService — the one gate for bot-initiated contact (ADR-0008)', () => {
  let policy: ContactPolicyService;
  // 2026-06-06 at the given UTC hour; with timezone 'UTC' the local hour equals the UTC hour.
  const at = (utcHour: number) =>
    new Date(Date.UTC(2026, 5, 6, utcHour, 0, 0));

  beforeEach(() => {
    policy = new ContactPolicyService();
  });

  it('allows a check-in during waking hours', () => {
    expect(policy.mayContact('UTC', 'checkin', at(14))).toEqual({ allow: true });
  });

  it('suppresses a check-in during quiet hours (recurring — no defer, the cron retries)', () => {
    expect(policy.mayContact('UTC', 'checkin', at(23))).toEqual({
      allow: false,
      deferUntil: null,
    });
  });

  it('allows a crisis follow-up during waking hours', () => {
    expect(policy.mayContact('UTC', 'crisis-follow-up', at(14))).toEqual({ allow: true });
  });

  it('defers a crisis follow-up out of quiet hours to the next allowed window (one-shot)', () => {
    const decision = policy.mayContact('UTC', 'crisis-follow-up', at(23));

    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      // 23:00 → next 08:00 is 9 hours later.
      expect(decision.deferUntil).toEqual(new Date(Date.UTC(2026, 5, 7, 8, 0, 0)));
    }
  });

  it('defers an early-morning crisis follow-up to 08:00 the same day', () => {
    const decision = policy.mayContact('UTC', 'crisis-follow-up', at(6));

    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.deferUntil).toEqual(new Date(Date.UTC(2026, 5, 6, 8, 0, 0)));
    }
  });

  it('treats an invalid timezone as quiet hours (safe default)', () => {
    expect(policy.inQuietHours('Not/AZone', at(14))).toBe(true);
  });
});
