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
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key] === undefined) process.env[key] = parseValue(rawVal);
  }
  return path;
}

/**
 * Parse a raw `.env` RHS the way dotenv does: a quoted value is taken verbatim (quotes stripped);
 * an unquoted value has any inline ` # comment` stripped and is trimmed. Without this, a line copied
 * from .env.example like `NCBI_API_KEY=   # optional ...` yields the COMMENT as the value, which then
 * gets sent as `&api_key=# optional ...` and 400s.
 */
function parseValue(rawVal: string): string {
  const quoted = rawVal.match(/^(['"])([\s\S]*?)\1\s*$/);
  if (quoted) return quoted[2];
  const cut = rawVal.replace(/\s+#.*$/, ''); // inline comment (must be whitespace-preceded)
  const v = cut.trimEnd();
  return v.startsWith('#') ? '' : v;
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
