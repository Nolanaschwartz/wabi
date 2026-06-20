/**
 * Shared setup for the gate-eval scripts (seed + run). Resolves the SEPARATE eval Langfuse project
 * keys — never the production worker's `LANGFUSE_*` — and builds a client bound to them.
 *
 * Lazy by construction (CLAUDE.md): keys are read from the environment at call time, never frozen at
 * import. Fails LOUD on missing config — these are dev CLIs, not the hot path, so a misconfiguration
 * should stop with a clear message rather than silently hitting the wrong project (or none).
 */
import { LangfuseClient } from '@langfuse/client';
import { loadDotenv } from '../src/util/load-env';

/** The eval dataset name in the eval project. */
export const GATE_DATASET = 'research-gate';

export interface EvalKeys {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Resolve the eval-project key pair + self-hosted base URL, or throw with what's missing. */
export function evalKeys(): EvalKeys {
  loadDotenv();
  const publicKey = process.env.LANGFUSE_EVAL_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_EVAL_SECRET_KEY;
  // Same host as the rest of the stack; only the project keys differ between prod and eval.
  const baseUrl = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL;
  const missing = [
    !publicKey && 'LANGFUSE_EVAL_PUBLIC_KEY',
    !secretKey && 'LANGFUSE_EVAL_SECRET_KEY',
    !baseUrl && 'LANGFUSE_HOST',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Eval Langfuse not configured — set ${missing.join(', ')} in root .env`);
  return { publicKey: publicKey!, secretKey: secretKey!, baseUrl: baseUrl! };
}

/** A LangfuseClient bound to the eval project (datasets, experiments, scores all land there). */
export function evalClient(keys: EvalKeys = evalKeys()): LangfuseClient {
  return new LangfuseClient({ publicKey: keys.publicKey, secretKey: keys.secretKey, baseUrl: keys.baseUrl });
}
