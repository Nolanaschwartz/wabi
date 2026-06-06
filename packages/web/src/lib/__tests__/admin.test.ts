import { getOperatorIds, isOperator } from '@/lib/admin';

describe('admin operator allowlist', () => {
  afterEach(() => {
    delete process.env.ADMIN_DISCORD_IDS;
  });

  it('treats no one as operator when ADMIN_DISCORD_IDS is unset', () => {
    delete process.env.ADMIN_DISCORD_IDS;
    expect(getOperatorIds()).toEqual([]);
    expect(isOperator('123')).toBe(false);
  });

  it('parses a comma-separated allowlist, trimming whitespace', () => {
    process.env.ADMIN_DISCORD_IDS = ' 123 , 456 ,, 789 ';
    expect(getOperatorIds()).toEqual(['123', '456', '789']);
  });

  it('recognizes an allowlisted operator and rejects others', () => {
    process.env.ADMIN_DISCORD_IDS = '123,456';
    expect(isOperator('123')).toBe(true);
    expect(isOperator('999')).toBe(false);
  });

  it('rejects null/undefined discord ids', () => {
    process.env.ADMIN_DISCORD_IDS = '123';
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});
