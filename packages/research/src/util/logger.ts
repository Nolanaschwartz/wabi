/**
 * Tiny structured logger for the research worker. Progress goes to STDERR so it does not mix with
 * any process-level output on STDOUT. Level is read lazily from RESEARCH_LOG_LEVEL on every call (CLAUDE.md:
 * never freeze env-derived state) — silent | info | debug, default info.
 */
export type LogLevel = 'silent' | 'info' | 'debug';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { info: () => {}, debug: () => {} };

const RANK: Record<LogLevel, number> = { silent: 0, info: 1, debug: 2 };

function fmtVal(v: unknown): string {
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  return String(v);
}

function fmt(msg: string, meta?: Record<string, unknown>): string {
  const kv = meta
    ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' ')
    : '';
  return `[research] ${msg}${kv}`;
}

/** Console logger gated by RESEARCH_LOG_LEVEL (re-read per call). */
export function defaultLogger(): Logger {
  const level = (): number => RANK[(process.env.RESEARCH_LOG_LEVEL as LogLevel) || 'info'] ?? RANK.info;
  return {
    info(msg, meta) {
      // eslint-disable-next-line no-console
      if (level() >= RANK.info) console.error(fmt(msg, meta));
    },
    debug(msg, meta) {
      // eslint-disable-next-line no-console
      if (level() >= RANK.debug) console.error(fmt(msg, meta));
    },
  };
}
