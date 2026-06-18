import { isValidCron } from '../cron-compile';

describe('cron-compile', () => {
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
