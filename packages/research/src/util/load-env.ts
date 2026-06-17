import { readFileSync, existsSync } from 'fs';
import { dirname, join, parse } from 'path';

/**
 * Load the root `.env` into process.env for the standalone worker. The bot gets its env via Nest's
 * ConfigModule; this process has no such loader, so without this every LLM call resolves to the
 * OpenAI default + empty key -> 401 -> silent failure (gate fails open, extract returns null,
 * tokens=0 everywhere). Zero-dep, and it never overrides a var already set in the environment.
 *
 * Resolution: WABI_ENV_FILE if set, else walk up from startDir (default cwd) to the first `.env`.
 * Returns the path loaded, or null if none was found.
 */
export function loadDotenv(startDir: string = process.cwd()): string | null {
  const explicit = process.env.WABI_ENV_FILE;
  const path = explicit && existsSync(explicit) ? explicit : findUp('.env', startDir);
  if (!path) return null;

  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, rawVal] = m;
    if (process.env[key] === undefined) process.env[key] = rawVal.replace(/^["']|["']$/g, '');
  }
  return path;
}

/** Walk up the directory tree from `start` looking for `name`; return its full path or null. */
function findUp(name: string, start: string): string | null {
  let dir = start;
  const root = parse(dir).root;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}
