/**
 * Run the CURRENT relevance gate over the `research-gate` eval dataset as a Langfuse experiment and
 * print quality + trust metrics, persisting them as scores on the run.
 *
 *   pnpm -F @wabi/research eval:gate   (run eval:seed first)
 *
 * The task calls `relevanceGate(abstract)` directly — no agent, runner, or pipeline. The dataset run
 * lands in the EVAL Langfuse project (separate keys), never production. The run is named with the
 * current git SHA (plus a timestamp, and a -dirty marker when the working tree has uncommitted
 * changes). Each run's metrics are appended to `evals/results.jsonl` — the DURABLE, greppable record
 * for comparing the gate across prompt revisions.
 *
 * KNOWN LIMITATION: per-item execution traces are NOT exported, and run-level evaluator scores do not
 * surface on the self-hosted dataset run. The shared `createLangfuseTracing` builds an ISOLATED OTEL
 * provider (so it never clobbers Sentry's global one in the bot), but the experiment runner emits
 * spans through the GLOBAL OTEL API — hence the SDK's "OpenTelemetry has not been set up" warning, and
 * with no exported trace the run has nothing for scores to attach to. The dataset run + items still
 * land, and results.jsonl is the source of truth for the numbers. Upgrade path: register the OTEL
 * provider globally in this script to get both per-item traces and persisted run scores.
 */
import { execSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { relevanceGate } from '../src/agent/relevance-gate';
import { gateMetrics, GateItemResult, GateMetrics, Label } from '../src/evals/gate-metrics';
import { evalClient, evalKeys, GATE_DATASET } from './eval-env';

// Repeats per item — the one trust knob. The gate calls a reasoning model whose determinism is only
// ASSERTED (temperature 0) and unproven, so we run each abstract N times to MEASURE flip-rate. A
// structurally ~0 flip-rate is the desired finding, not a wasted call; drop to 1 once it's proven ~0.
const N_REPEATS = 3;

/** Per-call outcome of the gate. `failed` = the call threw (provider down / 401 / transport) and fell
 * open with no trace; `empty` = the call RAN but returned empty/starved text. Kept distinct so a
 * provider outage can't masquerade as a high empty-reply-rate with plausible accuracy. */
interface ItemOutput {
  predictions: Label[];
  emptyReplies: boolean[];
  failures: boolean[];
}

function gitInfo(): { sha: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: 'nogit', dirty: false };
  }
}

// NOTE: for a Langfuse DATASET run the ground truth is on `it.item.expectedOutput`, NOT the top-level
// `it.expectedOutput` (which is undefined for dataset items). Reading the wrong one silently scores
// every comparison as a miss → accuracy 0; assertExpected() below turns any such drift into a loud
// failure instead of a plausible-looking zero.
type ResultItem = { output?: unknown; item?: { expectedOutput?: unknown } };

const toItem = (it: ResultItem): GateItemResult => {
  const out = (it.output ?? {}) as Partial<ItemOutput>;
  return {
    expected: it.item?.expectedOutput as Label,
    predictions: out.predictions ?? [],
    emptyReplies: out.emptyReplies ?? [],
    failures: out.failures ?? [],
  };
};

/** Fail loud if any item's ground truth isn't a valid label — guards against a silent all-zero score
 * if the SDK result shape ever changes again. */
function assertExpected(items: GateItemResult[]): void {
  const bad = items.filter((i) => i.expected !== 'keep' && i.expected !== 'reject').length;
  if (bad > 0) throw new Error(`${bad}/${items.length} items have no keep/reject expectedOutput — dataset or SDK result shape is wrong`);
}

async function main(): Promise<void> {
  const keys = evalKeys(); // fail loud if eval config is missing

  // Route OTEL spans to the EVAL project by pointing the shared tracing bootstrap at the eval keys.
  // This process does nothing but the eval, so overriding the standard LANGFUSE_* vars in-process is
  // intentional and isolated — it never affects the production worker. Imported lazily so the env is
  // set before the bootstrap reads it.
  process.env.LANGFUSE_PUBLIC_KEY = keys.publicKey;
  process.env.LANGFUSE_SECRET_KEY = keys.secretKey;
  const { createLangfuseTracing } = await import('@wabi/shared/otel');
  const tracing = createLangfuseTracing({ serviceName: 'wabi-research-eval', sampleRate: 1 });

  const { sha, dirty } = gitInfo();
  const client = evalClient(keys);

  // client.dataset.get (bound manager) — NOT the deprecated client.getDataset, which loses `this`.
  let dataset;
  try {
    dataset = await client.dataset.get(GATE_DATASET);
  } catch (e) {
    await tracing.shutdown();
    throw new Error(
      `Could not load dataset "${GATE_DATASET}" from the eval project (${(e as Error).message}). ` +
        `Seed it first: pnpm -F @wabi/research eval:seed`,
    );
  }

  // Run-level evaluator: recompute the aggregate metrics over all item results and return them as
  // scores so they PERSIST on the Langfuse dataset run (the whole point of naming runs by SHA — they
  // become comparable across prompt revisions in the UI, not just ephemeral console output).
  const runEvaluator = async ({ itemResults }: { itemResults: ResultItem[] }) => {
    const m = gateMetrics(itemResults.map(toItem));
    return (Object.keys(m) as (keyof GateMetrics)[]).map((name) => ({ name, value: m[name] }));
  };

  const ranAt = new Date().toISOString();
  const runName = `gate@${sha}${dirty ? '-dirty' : ''}-${ranAt.replace(/[:.]/g, '-')}`;
  const result = await dataset.runExperiment({
    name: 'gate',
    runName,
    description: 'Relevance-gate offline eval (ADR-0040, Phase 1).',
    metadata: { gitSha: sha, dirty },
    maxConcurrency: 4,
    task: async (item): Promise<ItemOutput> => {
      const abstract = (item.input as { abstract?: unknown } | undefined)?.abstract;
      // A malformed item (no abstract) is N FAILED calls, not a fake keep — never gate on "undefined".
      // N all-failed → the item is unscored (gateMetrics drops it), uniform with a provider outage.
      if (typeof abstract !== 'string' || abstract.trim() === '') {
        const n = Array.from({ length: N_REPEATS });
        return { predictions: n.map(() => 'keep' as Label), emptyReplies: n.map(() => false), failures: n.map(() => true) };
      }
      const predictions: Label[] = [];
      const emptyReplies: boolean[] = [];
      const failures: boolean[] = [];
      for (let i = 0; i < N_REPEATS; i++) {
        const r = await relevanceGate(abstract);
        const ran = !!r.trace; // the gate produced a trace ⇒ the model call actually executed
        failures.push(!ran); // no trace ⇒ caught error (provider down / 401), fell open to keep
        emptyReplies.push(ran && (r.trace?.output ?? '').trim() === ''); // RAN but starved/empty text
        predictions.push(r.keep ? 'keep' : 'reject');
      }
      return { predictions, emptyReplies, failures };
    },
    runEvaluators: [runEvaluator],
  });

  const items = result.itemResults.map(toItem);
  assertExpected(items);
  const metrics = gateMetrics(items); // failureRate now lives in the metric (and is persisted as a score)

  // Whether the dataset has been human-corrected (slice 4) — read straight off the item metadata.
  let reviewed = 0;
  for (const it of result.itemResults) {
    const md = (it.item as { metadata?: { reviewed?: boolean } } | undefined)?.metadata;
    if (md?.reviewed === true) reviewed++;
  }

  await tracing.forceFlush();
  await tracing.shutdown();
  await client.flush();

  console.log(`\n=== gate eval @ ${sha}${dirty ? ' (dirty tree)' : ''} (${items.length} items × ${N_REPEATS} repeats) ===`);
  console.log(`accuracy:         ${metrics.accuracy.toFixed(3)}`);
  console.log(`reject precision: ${metrics.rejectPrecision.toFixed(3)}`);
  console.log(`reject recall:    ${metrics.rejectRecall.toFixed(3)}`);
  console.log(`flip rate:        ${metrics.flipRate.toFixed(3)}  (0 ⇒ single-run numbers are trustworthy)`);
  console.log(`empty-reply rate: ${metrics.emptyReplyRate.toFixed(3)}  (RAN but starved; fail-open keeps)`);
  console.log(`failure rate:     ${metrics.failureRate.toFixed(3)}  (calls that never ran — provider/transport)`);
  if (result.datasetRunUrl) console.log(`\nLangfuse run: ${result.datasetRunUrl}`);

  // Durable, greppable record of every run — the source of truth for cross-revision comparison, since
  // run-level scores don't surface on the self-hosted dataset run (see KNOWN LIMITATION above).
  const resultsFile = join(__dirname, '../evals/results.jsonl');
  const record = { ranAt, runName, sha, dirty, items: items.length, reviewed, repeats: N_REPEATS, ...metrics, datasetRunUrl: result.datasetRunUrl ?? null };
  appendFileSync(resultsFile, JSON.stringify(record) + '\n', 'utf8');
  console.log(`recorded to ${resultsFile}`);

  // Loud guards so a masked run is never mistaken for a real baseline.
  if (metrics.failureRate >= 0.5) {
    console.error(
      `\n⚠️  INVALID BASELINE: ${(metrics.failureRate * 100).toFixed(0)}% of gate calls never ran (provider down / ` +
        `misconfigured). The metrics above are meaningless — fix the provider and re-run.`,
    );
    process.exitCode = 1;
  }
  if (reviewed === 0 && items.length > 0) {
    console.error(
      `\n⚠️  UNREVIEWED DATASET: no item is reviewed:true, so expectedOutput is the gate's OWN verdict. ` +
        `These numbers score the gate against itself — run the slice-4 correction pass before trusting them.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
