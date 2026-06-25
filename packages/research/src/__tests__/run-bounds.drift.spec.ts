import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULTS } from '../run-bounds';

/**
 * The one Run Bounds invariant types can't enforce: the DB-column DEFAULTS must mirror
 * `ResearchConfig`'s `@default`s in schema.prisma (ADR-0034). They are the fallback a degraded read
 * uses, so a drift silently changes how much a degraded run mines — the exact bug this module fixed
 * (the old fallback ran 3× the papers and reaped stale runs at 2× the wait). This parses the schema so a
 * future @default edit that forgets run-bounds.ts (or vice versa) fails CI instead of shipping green.
 */
describe('run-bounds DEFAULTS mirror the ResearchConfig schema @defaults', () => {
  const schema = readFileSync(
    resolve(__dirname, '../../../shared/prisma/schema.prisma'),
    'utf8',
  );
  const model = schema.match(/model ResearchConfig \{([\s\S]*?)\n\}/)?.[1];

  it('locates the ResearchConfig model in the schema', () => {
    expect(model).toBeTruthy();
  });

  // Every Bounds field except the env-only searchLimit is a DB column governed by a schema @default.
  const dbKeys = (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).filter(
    (k) => k !== 'searchLimit',
  );

  it.each(dbKeys)('%s mirrors its schema @default', (key) => {
    const match = model?.match(new RegExp(`\\b${key}\\b\\s+Int\\s+@default\\((\\d+)\\)`));
    expect(match).toBeTruthy(); // the column exists in the schema with an Int @default
    expect(DEFAULTS[key]).toBe(Number(match![1]));
  });
});
