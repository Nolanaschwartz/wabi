import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadDotenv } from '../load-env';

describe('loadDotenv', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wabi-env-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ['FOO', 'WITH_SPACES', 'PRESET', 'WABI_ENV_FILE', 'NCBI_API_KEY']) delete process.env[k];
    if (saved.WABI_ENV_FILE !== undefined) process.env.WABI_ENV_FILE = saved.WABI_ENV_FILE;
  });

  it('loads vars from a .env found by walking up from a nested dir', () => {
    writeFileSync(join(dir, '.env'), 'FOO=bar\n# a comment\nWITH_SPACES="a b c"\n');
    const nested = join(dir, 'packages', 'research');
    mkdirSync(nested, { recursive: true });
    const path = loadDotenv(nested);
    expect(path).toBe(join(dir, '.env'));
    expect(process.env.FOO).toBe('bar');
    expect(process.env.WITH_SPACES).toBe('a b c');
  });

  it('does NOT override a var already set in the environment', () => {
    process.env.PRESET = 'keep-me';
    writeFileSync(join(dir, '.env'), 'PRESET=from-file\n');
    loadDotenv(dir);
    expect(process.env.PRESET).toBe('keep-me');
  });

  it('returns null when no .env exists up the tree', () => {
    expect(loadDotenv(dir)).toBeNull();
  });

  it('strips an inline # comment from an unquoted value (dotenv semantics)', () => {
    // A line copied verbatim from .env.example, e.g. `NCBI_API_KEY=   # optional; raises cap`.
    writeFileSync(join(dir, '.env'), 'NCBI_API_KEY=   # optional; raises NCBI rate cap\nFOO=bar # trailing note\n');
    loadDotenv(dir);
    expect(process.env.NCBI_API_KEY).toBe('');
    expect(process.env.FOO).toBe('bar');
  });

  it('keeps a # that is inside a quoted value', () => {
    writeFileSync(join(dir, '.env'), 'FOO="a#b c"\n');
    loadDotenv(dir);
    expect(process.env.FOO).toBe('a#b c');
  });

  it('honors WABI_ENV_FILE over the walk-up search', () => {
    const explicit = join(dir, 'custom.env');
    writeFileSync(explicit, 'FOO=explicit\n');
    process.env.WABI_ENV_FILE = explicit;
    expect(loadDotenv(dir)).toBe(explicit);
    expect(process.env.FOO).toBe('explicit');
  });
});
