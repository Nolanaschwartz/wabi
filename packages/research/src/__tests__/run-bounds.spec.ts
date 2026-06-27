import { DEFAULTS, RANGES, fromConfigRow } from '../run-bounds';
import type { Bounds } from '../types';

describe('run-bounds', () => {
  describe('DEFAULTS', () => {
    it('the DB-column defaults mirror the ResearchConfig schema @defaults (drift fix)', () => {
      // These three drifted in the old DEFAULT_BOUNDS (24 / 240_000 / 1_200_000) and are corrected
      // here to match packages/shared/prisma/schema.prisma.
      expect(DEFAULTS.maxPapersPerTopic).toBe(8);
      expect(DEFAULTS.agentTimeoutMs).toBe(90_000);
      expect(DEFAULTS.runTimeoutMs).toBe(600_000);
      // The rest of the schema columns.
      expect(DEFAULTS.maxTopicsPerRun).toBe(5);
      expect(DEFAULTS.maxDiscoverySteps).toBe(2);
      expect(DEFAULTS.maxNeighborsConsidered).toBe(15);
      expect(DEFAULTS.maxChasePerExpansion).toBe(3);
      expect(DEFAULTS.budgetPressureFraction).toBe(0.2);
      expect(DEFAULTS.maxDraftsPerTopic).toBe(3);
      expect(DEFAULTS.maxDraftsPerRun).toBe(10);
      expect(DEFAULTS.tokenBudget).toBe(200_000);
      // The one env-only field.
      expect(DEFAULTS.searchLimit).toBe(40);
    });
  });

  describe('RANGES', () => {
    it('is keyed to exactly the eleven DB-governed bounds (not the env-only searchLimit)', () => {
      const keys = Object.keys(RANGES).sort();
      expect(keys).toEqual(
        [
          'agentTimeoutMs',
          'budgetPressureFraction',
          'maxChasePerExpansion',
          'maxDiscoverySteps',
          'maxDraftsPerRun',
          'maxDraftsPerTopic',
          'maxNeighborsConsidered',
          'maxPapersPerTopic',
          'maxTopicsPerRun',
          'runTimeoutMs',
          'tokenBudget',
        ].sort(),
      );
      expect(keys).toHaveLength(11);
      expect(keys).not.toContain('searchLimit');
    });
  });

  describe('fromConfigRow', () => {
    /** A valid singleton row carrying all eleven DB columns with non-default values. */
    const fullRow = {
      maxTopicsPerRun: 7,
      maxPapersPerTopic: 9,
      maxDiscoverySteps: 3,
      maxNeighborsConsidered: 20,
      maxChasePerExpansion: 5,
      budgetPressureFraction: 0.3,
      maxDraftsPerTopic: 4,
      maxDraftsPerRun: 12,
      agentTimeoutMs: 80_000,
      runTimeoutMs: 500_000,
      tokenBudget: 150_000,
    };

    it('maps a full valid row to Bounds, taking searchLimit from env', () => {
      const bounds = fromConfigRow(fullRow, { RESEARCH_SEARCH_LIMIT: '55' });
      const expected: Bounds = { ...fullRow, searchLimit: 55 };
      expect(bounds).toEqual(expected);
    });

    it('a null row yields all defaults (degraded read)', () => {
      expect(fromConfigRow(null, {})).toEqual(DEFAULTS);
    });

    it('falls back to the default per key when a value is missing', () => {
      const { maxPapersPerTopic, ...rest } = fullRow;
      const bounds = fromConfigRow(rest, {});
      expect(bounds.maxPapersPerTopic).toBe(DEFAULTS.maxPapersPerTopic);
      expect(bounds.maxTopicsPerRun).toBe(7); // other fields still honoured
    });

    it.each([
      ['zero', 0],
      ['negative', -5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a string', '9' as unknown as number],
      ['null', null as unknown as number],
    ])('falls back to the default when a value is %s', (_label, bad) => {
      const bounds = fromConfigRow({ ...fullRow, maxPapersPerTopic: bad }, {});
      expect(bounds.maxPapersPerTopic).toBe(DEFAULTS.maxPapersPerTopic);
    });

    it('takes searchLimit from env when finite and > 0', () => {
      expect(fromConfigRow(null, { RESEARCH_SEARCH_LIMIT: '120' }).searchLimit).toBe(120);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['zero', '0'],
      ['non-numeric', 'lots'],
    ])('falls back to the default searchLimit when env is %s', (_label, raw) => {
      expect(fromConfigRow(null, { RESEARCH_SEARCH_LIMIT: raw }).searchLimit).toBe(
        DEFAULTS.searchLimit,
      );
    });
  });
});
