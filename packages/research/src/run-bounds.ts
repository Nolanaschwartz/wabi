import { Bounds } from './types';

/**
 * The single owner of the **Run Bounds** (CONTEXT.md): the per-run resource caps a research run obeys
 * — the field set, the defaults, the valid ranges, and the `ResearchConfig`-row → {@link Bounds}
 * mapping. Pure: no Nest, no Prisma, no I/O. `ResearchConfigService.loadRunBounds()` is the thin DB
 * read that calls into here; the run-service and admin surface both go through that.
 *
 * The DB-column defaults below **MUST mirror `ResearchConfig`'s `@default`s** in
 * `packages/shared/prisma/schema.prisma` — they are the fallback used when the singleton row can't be
 * read, so a drift between them silently changes how much a degraded run mines (which is exactly the
 * bug this module fixes: the old fallback ran 3× the papers and reaped stale runs at 2× the wait).
 *
 * ponytail: kept in sync by this comment, NOT an enforcing test — accepted ceiling. Upgrade path if it
 * drifts again: a test that parses schema.prisma and asserts each @default equals DEFAULTS[key].
 */
export const DEFAULTS: Bounds = {
  maxTopicsPerRun: 5,
  maxPapersPerTopic: 8,
  searchLimit: 40, // the one env-only field (RESEARCH_SEARCH_LIMIT) — NOT a DB column (ADR-0034)
  maxDiscoverySteps: 2,
  maxDraftsPerTopic: 3,
  maxDraftsPerRun: 10,
  agentTimeoutMs: 90_000,
  runTimeoutMs: 600_000,
  tokenBudget: 200_000,
};

/** The eight DB-governed bounds (ADR-0034) — every {@link Bounds} field except the env-only searchLimit. */
export type ResearchBounds = Omit<Bounds, 'searchLimit'>;

/**
 * Inclusive valid ranges for the eight DB columns. Keyed by `keyof ResearchBounds` so the table can
 * never drift from the type: add a bound to {@link Bounds} and this Record (and the schema, and
 * DEFAULTS) fail to compile until updated.
 * - counts: 1..100 (a run touching >100 topics/papers per step is a config error)
 * - *_Ms timeouts: 1_000..3_600_000 (1s floor avoids instant cut-offs; 1h ceiling caps a runaway run)
 * - tokenBudget: 1_000..10_000_000 (1k floor guarantees real work; 10M caps spend)
 */
export const RANGES: Record<keyof ResearchBounds, { min: number; max: number }> = {
  maxTopicsPerRun: { min: 1, max: 100 },
  maxPapersPerTopic: { min: 1, max: 100 },
  maxDiscoverySteps: { min: 1, max: 100 },
  maxDraftsPerTopic: { min: 1, max: 100 },
  maxDraftsPerRun: { min: 1, max: 100 },
  agentTimeoutMs: { min: 1_000, max: 3_600_000 },
  runTimeoutMs: { min: 1_000, max: 3_600_000 },
  tokenBudget: { min: 1_000, max: 10_000_000 },
};

/** A finite, strictly-positive number — else undefined (so 0, NaN, strings, null all fall through). */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Map a `ResearchConfig` singleton row (or null) + the process env into a fully-populated
 * {@link Bounds}. Per key: a finite positive value from the row, else `DEFAULTS[key]`. The env-only
 * `searchLimit` comes from `RESEARCH_SEARCH_LIMIT` when finite & > 0, else the default. Never throws.
 */
export function fromConfigRow(
  row: Partial<Record<keyof Bounds, unknown>> | null,
  env: { RESEARCH_SEARCH_LIMIT?: string } = {},
): Bounds {
  const pick = (key: keyof ResearchBounds): number => positive(row?.[key]) ?? DEFAULTS[key];
  const searchLimit = positive(Number(env.RESEARCH_SEARCH_LIMIT)) ?? DEFAULTS.searchLimit;
  return {
    maxTopicsPerRun: pick('maxTopicsPerRun'),
    maxPapersPerTopic: pick('maxPapersPerTopic'),
    searchLimit,
    maxDiscoverySteps: pick('maxDiscoverySteps'),
    maxDraftsPerTopic: pick('maxDraftsPerTopic'),
    maxDraftsPerRun: pick('maxDraftsPerRun'),
    agentTimeoutMs: pick('agentTimeoutMs'),
    runTimeoutMs: pick('runTimeoutMs'),
    tokenBudget: pick('tokenBudget'),
  };
}
