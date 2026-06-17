import { compileCadence, isValidCron } from '../cron-compile';

describe('cron-compile', () => {
  describe('compileCadence — presets to 5-field cron', () => {
    it('Daily HH:MM → "M H * * *"', () => {
      expect(compileCadence({ kind: 'daily', hour: 3, minute: 0 })).toBe('0 3 * * *');
      expect(compileCadence({ kind: 'daily', hour: 14, minute: 30 })).toBe('30 14 * * *');
      expect(compileCadence({ kind: 'daily', hour: 0, minute: 0 })).toBe('0 0 * * *');
    });

    it('Weekly HH:MM + day-of-week (0–6) → "M H * * D"', () => {
      expect(compileCadence({ kind: 'weekly', hour: 9, minute: 15, dayOfWeek: 1 })).toBe(
        '15 9 * * 1',
      );
      expect(compileCadence({ kind: 'weekly', hour: 23, minute: 59, dayOfWeek: 0 })).toBe(
        '59 23 * * 0',
      );
      expect(compileCadence({ kind: 'weekly', hour: 6, minute: 0, dayOfWeek: 6 })).toBe(
        '0 6 * * 6',
      );
    });

    it('Monthly HH:MM + day-of-month (1–31) → "M H D * *"', () => {
      expect(compileCadence({ kind: 'monthly', hour: 2, minute: 0, dayOfMonth: 1 })).toBe(
        '0 2 1 * *',
      );
      expect(compileCadence({ kind: 'monthly', hour: 18, minute: 45, dayOfMonth: 15 })).toBe(
        '45 18 15 * *',
      );
      expect(compileCadence({ kind: 'monthly', hour: 0, minute: 0, dayOfMonth: 31 })).toBe(
        '0 0 31 * *',
      );
    });

    it('rejects out-of-range time/day inputs', () => {
      expect(() => compileCadence({ kind: 'daily', hour: 24, minute: 0 })).toThrow();
      expect(() => compileCadence({ kind: 'daily', hour: 0, minute: 60 })).toThrow();
      expect(() => compileCadence({ kind: 'daily', hour: -1, minute: 0 })).toThrow();
      expect(() => compileCadence({ kind: 'weekly', hour: 1, minute: 0, dayOfWeek: 7 })).toThrow();
      expect(() =>
        compileCadence({ kind: 'monthly', hour: 1, minute: 0, dayOfMonth: 0 }),
      ).toThrow();
      expect(() =>
        compileCadence({ kind: 'monthly', hour: 1, minute: 0, dayOfMonth: 32 }),
      ).toThrow();
    });

    it('compiled presets are themselves valid cron strings', () => {
      expect(isValidCron(compileCadence({ kind: 'daily', hour: 3, minute: 0 }))).toBe(true);
      expect(
        isValidCron(compileCadence({ kind: 'weekly', hour: 9, minute: 15, dayOfWeek: 1 })),
      ).toBe(true);
      expect(
        isValidCron(compileCadence({ kind: 'monthly', hour: 2, minute: 0, dayOfMonth: 1 })),
      ).toBe(true);
    });
  });

  describe('isValidCron — accepts well-formed 5-field crons', () => {
    it('accepts simple field values', () => {
      expect(isValidCron('0 3 * * *')).toBe(true);
      expect(isValidCron('30 14 * * *')).toBe(true);
      expect(isValidCron('15 9 * * 1')).toBe(true);
      expect(isValidCron('0 0 1 * *')).toBe(true);
      expect(isValidCron('* * * * *')).toBe(true);
    });

    it('accepts steps, ranges, and lists', () => {
      expect(isValidCron('*/5 * * * *')).toBe(true);
      expect(isValidCron('0 0,12 * * *')).toBe(true);
      expect(isValidCron('0 9-17 * * 1-5')).toBe(true);
      expect(isValidCron('0 0 1,15 * *')).toBe(true);
    });
  });

  describe('isValidCron — rejects malformed crons', () => {
    it('rejects the wrong number of fields', () => {
      expect(isValidCron('0 3 * *')).toBe(false); // 4 fields
      expect(isValidCron('0 3 * * * *')).toBe(false); // 6 fields
      expect(isValidCron('')).toBe(false);
      expect(isValidCron('   ')).toBe(false);
    });

    it('rejects out-of-range minute/hour/dom/dow', () => {
      expect(isValidCron('60 3 * * *')).toBe(false); // minute 60
      expect(isValidCron('0 24 * * *')).toBe(false); // hour 24
      expect(isValidCron('0 3 0 * *')).toBe(false); // dom 0
      expect(isValidCron('0 3 32 * *')).toBe(false); // dom 32
      expect(isValidCron('0 3 * 0 *')).toBe(false); // month 0
      expect(isValidCron('0 3 * 13 *')).toBe(false); // month 13
      expect(isValidCron('0 3 * * 7')).toBe(false); // dow 7
    });

    it('rejects garbage', () => {
      expect(isValidCron('not a cron')).toBe(false);
      expect(isValidCron('@daily')).toBe(false);
      expect(isValidCron('a b c d e')).toBe(false);
      expect(isValidCron('0 3 * * abc')).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isValidCron(null as unknown as string)).toBe(false);
      expect(isValidCron(undefined as unknown as string)).toBe(false);
      expect(isValidCron(123 as unknown as string)).toBe(false);
    });
  });
});
