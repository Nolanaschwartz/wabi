import { CheckInTiming } from '../checkin-timing';

// Quiet hours are 22:00–08:00 user-local; late-night is >= 23:00. These tests pin the
// current instant with fake timers and use DST-free zones (or UTC) so the user-local hour
// is deterministic, then assert the boundary behavior — not just the return type.

describe('CheckInTiming', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const at = (iso: string) => jest.useFakeTimers({ now: new Date(iso) });

  describe('isWithinQuietHours boundaries (UTC)', () => {
    it('is quiet at 07:59 (before the 08:00 end)', () => {
      at('2026-06-06T07:59:00Z');
      expect(CheckInTiming.isWithinQuietHours('UTC')).toBe(true);
    });

    it('is NOT quiet at exactly 08:00 (quiet-hours end)', () => {
      at('2026-06-06T08:00:00Z');
      expect(CheckInTiming.isWithinQuietHours('UTC')).toBe(false);
    });

    it('is NOT quiet at 21:00 (before the 22:00 start)', () => {
      at('2026-06-06T21:00:00Z');
      expect(CheckInTiming.isWithinQuietHours('UTC')).toBe(false);
    });

    it('is quiet at exactly 22:00 (quiet-hours start)', () => {
      at('2026-06-06T22:00:00Z');
      expect(CheckInTiming.isWithinQuietHours('UTC')).toBe(true);
    });
  });

  describe('isLateNightForUser boundary (UTC)', () => {
    it('is NOT late night at 22:00', () => {
      at('2026-06-06T22:00:00Z');
      expect(CheckInTiming.isLateNightForUser('UTC')).toBe(false);
    });

    it('is late night at 23:00', () => {
      at('2026-06-06T23:00:00Z');
      expect(CheckInTiming.isLateNightForUser('UTC')).toBe(true);
    });
  });

  describe('cross-timezone at a fixed instant (12:00 UTC, DST-free zones)', () => {
    beforeEach(() => at('2026-06-06T12:00:00Z'));

    it('Asia/Tokyo (UTC+9 → 21:00) is daytime', () => {
      expect(CheckInTiming.isWithinQuietHours('Asia/Tokyo')).toBe(false);
      expect(CheckInTiming.isLateNightForUser('Asia/Tokyo')).toBe(false);
    });

    it('America/Phoenix (UTC-7 → 05:00) is within quiet hours', () => {
      expect(CheckInTiming.isWithinQuietHours('America/Phoenix')).toBe(true);
    });

    it('Pacific/Honolulu (UTC-10 → 02:00) is within quiet hours', () => {
      expect(CheckInTiming.isWithinQuietHours('Pacific/Honolulu')).toBe(true);
    });

    it('Pacific/Noumea (UTC+11 → 23:00) is late night and quiet', () => {
      expect(CheckInTiming.isLateNightForUser('Pacific/Noumea')).toBe(true);
      expect(CheckInTiming.isWithinQuietHours('Pacific/Noumea')).toBe(true);
    });
  });

  describe('isCheckInDue honors cadence and quiet hours', () => {
    it('is due with no prior check-in during the day (Asia/Tokyo 21:00)', () => {
      at('2026-06-06T12:00:00Z');
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: null, cadence: 'daily', timezone: 'Asia/Tokyo' }),
      ).toBe(true);
    });

    it('is never due inside quiet hours, even with no prior check-in (Phoenix 05:00)', () => {
      at('2026-06-06T12:00:00Z');
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: null, cadence: 'daily', timezone: 'America/Phoenix' }),
      ).toBe(false);
    });

    it('daily cadence: not due 12h after last check-in, due after 24h (Asia/Tokyo daytime)', () => {
      at('2026-06-06T12:00:00Z');
      const halfDayAgo = new Date('2026-06-06T00:00:00Z');
      const dayAgo = new Date('2026-06-05T11:00:00Z');
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: halfDayAgo, cadence: 'daily', timezone: 'Asia/Tokyo' }),
      ).toBe(false);
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: dayAgo, cadence: 'daily', timezone: 'Asia/Tokyo' }),
      ).toBe(true);
    });

    it('weekly cadence: not due after 3 days, due after 8 days (Asia/Tokyo daytime)', () => {
      at('2026-06-06T12:00:00Z');
      const threeDaysAgo = new Date('2026-06-03T12:00:00Z');
      const eightDaysAgo = new Date('2026-05-29T12:00:00Z');
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: threeDaysAgo, cadence: 'weekly', timezone: 'Asia/Tokyo' }),
      ).toBe(false);
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: eightDaysAgo, cadence: 'weekly', timezone: 'Asia/Tokyo' }),
      ).toBe(true);
    });
  });

  describe('invalid/missing timezone falls back safely', () => {
    it('treats an invalid timezone as quiet hours (no crash)', () => {
      at('2026-06-06T12:00:00Z');
      expect(CheckInTiming.isWithinQuietHours('invalid/timezone')).toBe(true);
      expect(CheckInTiming.isLateNightForUser('not-a-zone')).toBe(true);
    });

    it('is not due with an invalid timezone (safe default)', () => {
      at('2026-06-06T12:00:00Z');
      expect(
        CheckInTiming.isCheckInDue({ lastCheckIn: null, cadence: 'daily', timezone: 'invalid/timezone' }),
      ).toBe(false);
    });
  });
});
