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
import { Label } from '../src/evals/gate-metrics';

/** The eval dataset name in the eval project. */
export const GATE_DATASET = 'research-gate';

export type Bucket = 'positive' | 'negative';

/** One row of the gate eval dataset (the JSONL on disk and what gets upserted to Langfuse). Shared by
 * the bootstrap (writer) and seed (reader) so the schema can't drift between them. */
export interface DatasetRow {
  input: { abstract: string };
  expectedOutput: Label;
  metadata: { source: string; id: string; topic: string; bucket: Bucket; modelLabel: Label; reviewed: boolean };
}

const isLabel = (x: unknown): x is Label => x === 'keep' || x === 'reject';

/** Parse + validate the dataset JSONL. Throws with the 1-based line number on the first bad row so a
 * typo or schema drift fails loudly here, never as a silent permanent mismatch in the eval. */
export function parseDatasetRows(text: string): DatasetRow[] {
  const rows: DatasetRow[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t === '') return;
    const where = `dataset row ${i + 1}`;
    let o: { input?: { abstract?: unknown }; expectedOutput?: unknown; metadata?: Record<string, unknown> };
    try {
      o = JSON.parse(t);
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }
    const abstract = o.input?.abstract;
    if (typeof abstract !== 'string' || abstract.trim() === '') throw new Error(`${where}: input.abstract must be a non-empty string`);
    if (!isLabel(o.expectedOutput)) throw new Error(`${where}: expectedOutput must be 'keep' or 'reject'`);
    const m = o.metadata ?? {};
    if (m.bucket !== 'positive' && m.bucket !== 'negative') throw new Error(`${where}: metadata.bucket must be 'positive' or 'negative'`);
    if (typeof m.id !== 'string' || m.id === '') throw new Error(`${where}: metadata.id is required`);
    if (!isLabel(m.modelLabel)) throw new Error(`${where}: metadata.modelLabel must be 'keep' or 'reject'`);
    rows.push(o as DatasetRow);
  });
  return rows;
}

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
