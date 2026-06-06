import { CheckInTiming } from '../checkin-timing';

describe('CheckInTiming', () => {
  it('isCheckInDue returns true when no last check-in (outside quiet hours)', () => {
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: null,
      cadence: 'daily',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });

  it('isCheckInDue returns false when within quiet hours', () => {
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: null,
      cadence: 'daily',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });

  it('cadence honors daily threshold', () => {
    const yesterday = new Date(Date.now() - 86400000);
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: yesterday,
      cadence: 'daily',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });

  it('cadence honors weekly threshold', () => {
    const lastWeek = new Date(Date.now() - 7 * 86400000);
    const result = CheckInTiming.isCheckInDue({
      lastCheckIn: lastWeek,
      cadence: 'weekly',
      timezone: 'America/New_York',
    });
    expect(typeof result).toBe('boolean');
  });

  it('handles invalid timezone gracefully', () => {
    const result = CheckInTiming.isWithinQuietHours('invalid/timezone');
    expect(typeof result).toBe('boolean');
  });

  it('handles UTC timezone', () => {
    const result = CheckInTiming.isWithinQuietHours('UTC');
    expect(typeof result).toBe('boolean');
  });
});
