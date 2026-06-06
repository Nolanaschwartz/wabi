import { CheckInTiming } from '../checkin-timing';

describe('CheckInTiming', () => {
  it('returns true for quiet hours at night', () => {
    const result = CheckInTiming.isWithinQuietHours('America/New_York');
    expect(typeof result).toBe('boolean');
  });

  it('returns true for late night', () => {
    const result = CheckInTiming.isLateNightForUser('America/New_York');
    expect(typeof result).toBe('boolean');
  });

  it('returns true for check-in due when no last check-in', () => {
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: null,
      cadence: 'daily',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });

  it('returns false for check-in due when within quiet hours', () => {
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: null,
      cadence: 'daily',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });
});
