/**
 * Pure cron validation (ADR-0034). No I/O, no env — the single source of cron truth for the API's
 * validation gate before pg-boss. A malformed cron must be rejected HERE, before it ever reaches
 * pg-boss, so an operator never saves a schedule that silently never fires.
 *
 * We hand-roll a strict 5-field validator rather than lean on a parser, so the accepted grammar is
 * exactly what we intend: minute hour day-of-month month day-of-week, with `*`, steps (`*\/n`,
 * `a-b/n`), ranges (`a-b`), and comma lists — and nothing else (no `@daily`, no 6-field/seconds,
 * no `7`-as-Sunday). Field bounds are the standard Unix ranges.
 */

/** Inclusive bounds for each of the five cron fields, in field order. */
const FIELD_BOUNDS: { min: number; max: number }[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week (0 = Sunday; 7 is NOT accepted)
];

/** Validate a single cron field token against its [min, max] bounds. */
function isValidField(token: string, min: number, max: number): boolean {
  if (token === '*') return true;

  // A comma list: every element must independently validate.
  if (token.includes(',')) {
    const parts = token.split(',');
    if (parts.length < 2) return false;
    return parts.every((p) => isValidField(p, min, max));
  }

  // A step: `<base>/<n>` where base is `*` or a range, and n is a positive integer.
  if (token.includes('/')) {
    const [base, stepStr, ...rest] = token.split('/');
    if (rest.length > 0) return false;
    if (!/^\d+$/.test(stepStr)) return false;
    const step = Number(stepStr);
    if (step < 1) return false;
    if (base === '*') return true;
    return isRange(base, min, max);
  }

  // A range: `a-b`.
  if (token.includes('-')) return isRange(token, min, max);

  // A bare integer in-bounds.
  if (!/^\d+$/.test(token)) return false;
  const n = Number(token);
  return n >= min && n <= max;
}

/** Validate an `a-b` range token: both ends in-bounds and a <= b. */
function isRange(token: string, min: number, max: number): boolean {
  const m = /^(\d+)-(\d+)$/.exec(token);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= min && a <= max && b >= min && b <= max && a <= b;
}

/**
 * True iff `cron` is a well-formed 5-field cron string with every field in-bounds. The validation
 * gate before anything reaches pg-boss.
 */
export function isValidCron(cron: string): boolean {
  if (typeof cron !== 'string') return false;
  const fields = cron.trim().split(/\s+/);
  if (cron.trim() === '' || fields.length !== 5) return false;
  return fields.every((field, i) => isValidField(field, FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max));
}
